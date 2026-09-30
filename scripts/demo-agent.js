// Agent logic for the demo UI: Claude tool definition + loop, and the "script" fallback (address parser + templated answer).
export const MAX_PAID_CALLS = 2; // per question: a runaway agent can spend at most $0.10

// ---------------- Claude agent ----------------

export const CHECK_TOOL = {
  name: "check_rent_status",
  description:
    "Look up a San Francisco rental building in official city records: SF Assessor roll (year built, legal unit count, zoning, use) " +
    "and DBI (Department of Building Inspection) complaint history, and return a rent-control verdict with red flags. " +
    "Each call costs $0.05 USDC, paid automatically from your wallet via x402 on Solana, so call it once per address " +
    "and never repeat a call for an address you already checked. Pass the address as the user wrote it, including any " +
    "apartment or unit number (e.g. \"372 7th Ave Apt 5\"), because the unit number is checked against the legal unit count.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Street address in San Francisco, with unit number if given, e.g. \"1665 Chestnut St\" or \"372 7th Ave Apt 5\"." },
    },
    required: ["address"],
    additionalProperties: false,
  },
  strict: true,
};

export const SYSTEM_PROMPT = `You are a renter's assistant agent for San Francisco apartments. You have one tool, check_rent_status, which pulls official city records for a building (year built, legal units, zoning, rent-control status, DBI complaint history and red flags).

The tool costs $0.05 USDC per call, paid from your own wallet. Use it once per address the user asks about; don't call it twice for the same address, and don't call it if the user hasn't given an address (ask for one instead).

After you get the result, answer the renter in plain English in 3 to 5 sentences:
- Say whether the building is likely under SF rent control, and why (year built, number of units).
- Name the most important red flags with their dates (for example mold, a broken elevator, no heat, more units rented than are legal), or say clearly that the record is clean.
- End with one or two concrete questions the renter should ask the landlord before signing.
Write plain prose with no headings, lists or markdown. You may bold at most two short phrases with **double asterisks**. Don't say you are an AI and don't repeat the raw JSON. This is informational, not legal advice; say so in a few words only if it matters.`;

export async function runClaude({ anthropic, model, question, send, doCheck }) {
  const messages = [{ role: "user", content: question }];
  const checked = new Map(); // address -> tool result text (no double-paying within one question)
  let paidCalls = 0;
  let useFallbacks = true;

  for (let turn = 0; turn < 5; turn++) {
    const params = {
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [CHECK_TOOL],
      messages,
      output_config: { effort: "low" },
    };
    if (useFallbacks) Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

    let message;
    try {
      const stream = anthropic.beta.messages.stream(params);
      stream.on("text", (delta) => send("agent_text", { delta }));
      message = await stream.finalMessage();
    } catch (err) {
      // Server-side fallback is a beta; if this account/model rejects it, retry the turn without it.
      if (useFallbacks && err?.status === 400 && /fallback/i.test(err.message)) {
        useFallbacks = false;
        turn--;
        continue;
      }
      throw err;
    }

    if (message.stop_reason === "refusal") {
      send("agent_text", { delta: "\n(Claude declined to answer this one.)" });
      return;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || !toolUses.length) return; // end_turn / max_tokens: done

    messages.push({ role: "assistant", content: message.content });
    const results = [];
    for (const tu of toolUses) {
      const address = typeof tu.input?.address === "string" ? tu.input.address.trim() : "";
      send("tool_call", { name: tu.name, input: tu.input, id: tu.id });
      let content, is_error = false;
      if (tu.name !== CHECK_TOOL.name || !address) {
        content = "Error: unknown tool or missing address.";
        is_error = true;
      } else if (checked.has(address.toLowerCase())) {
        content = checked.get(address.toLowerCase()); // already paid for this one
      } else if (paidCalls >= MAX_PAID_CALLS) {
        content = `Error: spending limit reached (${MAX_PAID_CALLS} paid calls per question). Answer with what you have.`;
        is_error = true;
      } else {
        paidCalls++;
        try {
          const data = await doCheck(address);
          content = JSON.stringify(data);
          checked.set(address.toLowerCase(), content);
        } catch (err) {
          content = `Error: ${err.message}`;
          is_error = true;
        }
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error });
    }
    messages.push({ role: "user", content: results });
  }
}

// ---------------- Script mode ----------------

const SUFFIX = "St|Street|Ave|Av|Avenue|Blvd|Boulevard|Dr|Drive|Way|Ter|Terrace|Ct|Court|Pl|Place|Ln|Lane|Rd|Road|Hwy|Cir|Aly|Alley|Row|Walk";
const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,5}[A-Za-z]?(?:\s+[A-Za-z0-9']+){1,4}?\s+(?:${SUFFIX})\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*#?\w+)?)`,
  "i",
);

export function extractAddress(text) {
  const s = String(text || "").trim();
  const m = s.match(ADDRESS_RE);
  if (m) return m[1].replace(/\s+/g, " ").replace(/,\s*(Apt|Apartment|Unit|Suite|Ste|#)/i, " $1").trim();
  if (/^\d+\s+\S+/.test(s) && s.length < 80) return s; // "1824 Anza" without a suffix
  return null;
}

const txt = (x) => (x == null ? "" : typeof x === "string" ? x : x.label || x.title || x.summary || x.message || x.type || x.category || "");
const unitFlagged = (uc) => !!uc && (uc.flag === true || uc.flagged === true || uc.warning === true);

// Plain-English answer for script mode (no LLM), built from the API result.
export function templateSummary(d) {
  if (!d || d.found === false) return `I couldn't find "${d?.address_query || "that address"}" in San Francisco property records. Check the spelling, or try the street number and street name only.`;
  const parts = [];
  const rc = d.rent_control?.status;
  const facts = [d.year_built && `built ${d.year_built}`, d.units != null && `${d.units} legal unit${d.units === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  const where = `${d.matched_address}${facts ? ` (${facts})` : ""}`;
  const uc = d.unit_check;
  const unitFlag = unitFlagged(uc);

  if (unitFlag) parts.push(`**Careful:** ${uc.note || "the unit you asked about may not be one of the building's legal units"}${/[.!]$/.test(uc.note || "") ? "" : "."}`);
  if (rc === "likely") parts.push(`${where} is **likely under SF rent control**, so increases are capped and evictions need just cause.`);
  else if (rc === "not_covered") parts.push(`${where} is not under SF rent control because it was built after 1979${d.rent_control?.state_cap ? ", but the statewide AB 1482 cap likely applies" : ""}.`);
  else if (rc === "exempt_increases") parts.push(`${where} has no local cap on rent increases (Costa-Hawkins), though eviction protections may apply.`);
  else parts.push(`${where}: rent-control status is unclear from city records.`);

  const flags = Array.isArray(d.red_flags) ? d.red_flags : [];
  const c = d.complaints || {};
  if (flags.length) {
    const named = flags.slice(0, 3).map((f) => {
      const when = f.years || f.latest_date || f.date || "";
      return `${txt(f) || String(f)}${when ? ` (${when})` : ""}`;
    });
    parts.push(`Its DBI complaint history shows red flags: ${named.join(", ")}.`);
  } else if (c.total == null || c.error) {
    parts.push("The complaint history didn't load this time, so check it again before signing.");
  } else if (typeof c.problems === "number" ? c.problems === 0 : !c.total) {
    parts.push(`The record is clean: ${c.total ? `only ${c.total} routine inspection record${c.total === 1 ? "" : "s"}` : "no DBI complaints"} on file.`);
  } else {
    parts.push(`There ${c.total === 1 ? "is 1 DBI complaint" : `are ${c.total} DBI complaints`} on file, ${c.open ? `${c.open} still open` : "none open"}.`);
  }

  const hay = JSON.stringify(flags).toLowerCase();
  const asks = [];
  if (unitFlag || /illegal|without (a )?permit|change of use|unwarranted/.test(hay)) asks.push("whether your unit is a legal, permitted unit");
  if (/mold/.test(hay)) asks.push("how the mold was fixed");
  if (/elevator/.test(hay)) asks.push("whether the elevator is reliable now");
  if (/heat|hot water|temperature/.test(hay)) asks.push("how heat and hot water are handled");
  if (asks.length) parts.push(`Ask the landlord ${asks.slice(0, 2).join(" and ")}.`);
  else if (rc === "likely") parts.push("Looks like a green light; ask the landlord to confirm the unit is covered by the Rent Ordinance.");
  return parts.join(" ");
}
