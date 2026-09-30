// rent-check demo UI: sends the question to the local demo server and animates the SSE events it streams back.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s, a = 4, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
const fmtUsdc = (n) => (n == null ? "–" : Number(n).toFixed(2));
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

let config = {};
let busy = false;
let agentBubble = null;
let agentText = "";

// ---------------- boot ----------------
(async function boot() {
  try {
    config = await (await fetch("/api/config")).json();
    const badge = $("mode-badge");
    badge.textContent = config.mode === "claude" ? `Agent: Claude · ${config.model}` : "Agent: script";
    badge.className = `badge ${config.mode}`;
    $("api-url").textContent = config.apiUrl.replace(/^https?:\/\//, "");
    const a = $("buyer");
    a.textContent = short(config.buyer, 6, 6);
    a.href = `https://explorer.solana.com/address/${config.buyer}/tokens?cluster=devnet`;
    const b = await (await fetch("/api/balance")).json();
    $("bal-before").textContent = fmtUsdc(b.usdc);
  } catch {
    $("mode-badge").textContent = "Demo server not reachable";
  }
})();

document.querySelectorAll("#quick button").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (busy) return;
    $("q").value = btn.dataset.q;
    ask(btn.dataset.q);
  }),
);
$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q && !busy) ask(q);
});

// ---------------- chat ----------------
function addMsg(cls, html) {
  $("hint")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $("messages").appendChild(el);
  $("messages").scrollTop = 1e9;
  return el;
}
function agentSay(delta, whole) {
  if (!agentBubble) {
    agentBubble = addMsg("agent typing", "");
    agentText = "";
  }
  agentText = whole ? delta : agentText + delta;
  const who = config.mode === "claude" ? "Claude" : "Agent";
  agentBubble.innerHTML = `<span class="who">${who}</span>${md(agentText.trim())}`;
  $("messages").scrollTop = 1e9;
}
function endAgentBubble() {
  agentBubble?.classList.remove("typing");
  agentBubble = null;
}

// ---------------- timeline ----------------
function setStep(id, state, pill, pillColor) {
  const el = $(id);
  el.hidden = false;
  el.className = `step ${state}`;
  if (pill) {
    const p = $(`${id}-pill`);
    p.textContent = pill;
    p.className = `pill ${pillColor || "grey"}`;
  }
}
function resetTimeline() {
  for (const id of ["s-402", "s-pay", "s-200"]) {
    setStep(id, "", "waiting", "grey");
    $(`${id}-detail`).innerHTML = "";
  }
  $("s-402-what").textContent = "GET /check";
  $("s-tool").hidden = config.mode !== "claude";
  $("s-tool").className = "step";
  $("s-tool-detail").textContent = "";
  $("s-tool-pill").textContent = "thinking";
  $("s-tool-pill").className = "pill grey";
}
function failActiveStep(msg) {
  const active = ["s-tool", "s-402", "s-pay", "s-200"].find((id) => $(id).classList.contains("active"));
  if (active) {
    setStep(active, "fail", "failed", "red");
    const d = $(`${active}-detail`);
    d.innerHTML = `<span style="color:#ffb4b4">${esc(msg)}</span>`;
  }
}

function onStep(d) {
  if (d.step === "request") {
    $("s-402-what").textContent = `GET ${decodeURIComponent(d.path)}`;
    setStep("s-402", "active", "sending…", "blue");
  } else if (d.step === "payment_required") {
    setStep("s-402", "done warn", "402 Payment Required", "red");
    $("s-402-detail").innerHTML = [
      `<span>Price <b>$${d.price.toFixed(2)} ${esc(d.currency)}</b></span>`,
      `<span>Network <b>${esc(d.networkName)}</b></span>`,
      `<span>Pay to <a class="mono" target="_blank" rel="noopener" href="${esc(d.payToUrl)}">${esc(short(d.payTo))}</a></span>`,
      d.feePayer ? `<span>Gas: <b>facilitator</b></span>` : "",
    ].join("");
    $("s-pay-amt").textContent = `${d.price} ${d.currency}`;
  } else if (d.step === "paying") {
    setStep("s-pay", "active", "signing…", "blue");
    $("s-pay-detail").innerHTML = `<span>From <b class="mono">${esc(short(d.from))}</b></span><span>signed x402 payment…</span>`;
  } else if (d.step === "paid") {
    setStep("s-pay", "done", "✓ Paid on-chain", "green");
    const tx = d.transaction
      ? `<span>Tx <a class="mono" target="_blank" rel="noopener" href="${esc(d.explorer)}">${esc(short(d.transaction, 8, 8))} ↗</a></span>`
      : `<span>Settled (no tx id returned)</span>`;
    $("s-pay-detail").innerHTML = `<span>From <b class="mono">${esc(short(d.payer))}</b></span>${tx}`;
    setStep("s-200", "active", "loading…", "blue");
  } else if (d.step === "response") {
    setStep("s-200", "done", `✓ ${d.status} OK`, "green");
    const data = d.data || {};
    $("s-200-detail").textContent = data.found === false
      ? "Address not found in SF property records."
      : `${(data.sources || []).length} city datasets. Charged only because it answered.`;
  }
}

// ---------------- verdict card ----------------
const pick = (o, keys) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
  return null;
};
const asText = (x) => (x == null ? "" : typeof x === "string" || typeof x === "number" ? String(x) : pick(x, ["label", "title", "summary", "message", "status", "type", "category", "name"]) || "");
const isFlagged = (uc) => !!uc && (uc.flag === true || uc.flagged === true || uc.warning === true);
const SERIOUS = /mold|safety|fire|illegal|unwarranted|unpermitted|permit|zoning|structural|sewage|rodent|pest/i;

function statusPill(d) {
  const s = d.rent_control?.status;
  if (s === "likely") return ["green", "Rent-controlled: likely"];
  if (s === "not_covered") return ["grey", "Not under SF rent control"];
  if (s === "exempt_increases") return ["amber", "No rent-increase cap"];
  return ["amber", "Rent control: unclear"];
}

// red_flags[]: { category, label, count, latest_date, years, examples: [{ date, description }] } (strings tolerated too)
function renderFlag(f, i) {
  if (typeof f === "string") f = { label: f };
  const label = asText(f) || "Red flag";
  const sev = String(pick(f, ["severity", "level"]) || "").toLowerCase();
  const cls = /high|severe|critical/.test(sev) || SERIOUS.test(`${f.category || ""} ${label}`) ? "high" : /low|info|minor/.test(sev) ? "low" : "";
  // One quote per flag: the most vivid one (shortest with real content).
  let examples = Array.isArray(f.examples) ? f.examples.filter((e) => e && (e.description || typeof e === "string")) : [];
  if (examples.length > 1) {
    const len = (e) => String(e.description || e).length;
    const good = examples.filter((e) => len(e) >= 30).sort((a, b) => len(a) - len(b));
    examples = [good[0] || examples[0]];
  }
  if (!examples.length) {
    const quote = pick(f, ["quote", "example", "excerpt", "description", "detail", "text"]);
    if (quote) examples = [{ description: typeof quote === "string" ? quote : asText(quote), date: pick(f, ["date", "latest_date"]) }];
  }
  const years = pick(f, ["years", "dates"]);
  const when = Array.isArray(years) ? years.join(", ") : years || pick(f, ["latest_date", "date"]) || "";
  const count = pick(f, ["count", "n"]);
  const meta = [when, count > 1 ? `${count} complaints` : ""].filter(Boolean).join(" · ");
  const quotes = examples
    .map((e) => (typeof e === "string" ? { description: e } : e))
    .filter((e) => e.description && e.description !== label)
    .map((e) => `<div class="q"><i>“${esc(e.description)}”</i>${e.date ? ` <span class="d">${esc(e.date)}</span>` : ""}</div>`)
    .join("");
  return `<div class="flag ${cls}" style="animation-delay:${0.08 * i}s">
    <div class="chipcol"><span class="chip">${esc(label)}</span>${meta ? `<div class="d">${esc(meta)}</div>` : ""}</div>
    <div class="quotes">${quotes}</div>
  </div>`;
}

function softStoryText(ss) {
  if (ss == null) return null;
  if (typeof ss === "string") return ss;
  if (ss.on_list === false) return null; // not a soft-story building: nothing to say
  if (ss.retrofit_complete) return `retrofit complete${ss.status ? ` (${ss.status})` : ""}`;
  return ss.status || (ss.on_list ? "on the city's list, retrofit not complete" : null);
}

function renderVerdict(d) {
  const box = $("verdict");
  if (!d || d.found === false) {
    box.innerHTML = `<div class="card"><div class="card-head"><div><div class="addr">${esc(d?.address_query || "")}</div>
      <div class="addr-sub">${esc(d?.verdict || "Not found")}</div></div><span class="status grey">Not found</span></div></div>`;
    return;
  }
  const [color, label] = statusPill(d);
  const c = d.complaints || {};
  const flags = Array.isArray(d.red_flags) ? d.red_flags : null;
  const uc = d.unit_check;
  const flagged = isFlagged(uc);
  const complaintsKnown = c.total != null && !c.error;
  const clean = complaintsKnown && !flagged && (flags ? flags.length === 0 : !c.open && c.total <= 1);
  const ss = softStoryText(d.soft_story);

  const complaintsFact = !complaintsKnown ? "n/a" : `${c.total}${typeof c.problems === "number" && c.problems !== c.total ? ` (${c.problems} problems)` : ""}${c.open ? ` · ${c.open} open` : ""}`;
  const facts = [
    ["Year built", d.year_built ?? "–"],
    ["Legal units", d.units ?? "–"],
    ["Zoning", d.zoning ?? "–"],
    ["DBI complaints", complaintsFact],
  ];

  let html = `<div class="card">
    <div class="card-head">
      <div><div class="addr">${esc(d.matched_address)}</div>
        <div class="addr-sub">${esc(d.use || "")}${d.parcel ? ` · parcel ${esc(d.parcel)}` : ""}${d.address_query && d.address_query !== d.matched_address ? ` · asked: “${esc(d.address_query)}”` : ""}</div></div>
      <div class="pills"><span class="status ${color}">${esc(label)}</span>${d.rent_control?.state_cap ? `<span class="status-sub">${esc(d.rent_control.state_cap)}</span>` : ""}</div>
    </div>`;

  if (flagged) {
    const msg = pick(uc, ["note", "message", "reason", "summary", "detail"]) || "The unit in the listing may not be one of the building's legal units.";
    const unit = uc.claimed_unit ?? uc.requested_unit ?? uc.unit;
    const extra = [unit != null ? `Listing: Apt ${unit}` : "", uc.legal_units != null ? `City record: ${uc.legal_units} legal units` : ""].filter(Boolean).join("  ·  ");
    html += `<div class="banner"><span class="ico">!</span><div>${esc(msg)}${extra ? `<small>${esc(extra)}</small>` : ""}</div></div>`;
  }

  html += `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v${String(v).length > 8 ? " small" : ""}">${esc(v)}</div></div>`).join("")}</div>`;
  if (d.rent_control?.reason) html += `<div class="reason">${esc(d.rent_control.reason)}</div>`;
  if (ss) html += `<div class="reason">Soft-story (earthquake) program: <b style="color:var(--text)">${esc(ss)}</b></div>`;

  if (clean) {
    html += `<div class="clean"><div class="big">✓</div><div><div class="t">Clean record</div>
      <div class="s">${c.total ? `Only ${c.total} routine record${c.total === 1 ? "" : "s"} on file (${esc(c.latest?.[0]?.description || "no problems")}), nothing open.` : "No DBI complaints on file."}</div></div></div>`;
  } else if (flags && flags.length) {
    html += `<div class="section-title">Red flags from DBI complaints</div><div class="flags">${flags.map(renderFlag).join("")}</div>`;
  } else if (Array.isArray(c.latest) && c.latest.length) {
    html += `<div class="section-title">Latest DBI complaints</div><div class="flags">${c.latest
      .map((x, i) => renderFlag({ label: x.status || "Complaint", examples: [{ description: x.description, date: x.date }], severity: x.status === "Active" ? "high" : "low" }, i))
      .join("")}</div>`;
  }
  if (c.error) html += `<div class="note">DBI complaint history didn't load this time (city server slow). Rent-control and unit facts above are complete.</div>`;

  html += `<div class="foot"><span>Sources: ${esc((d.sources || []).join(" · "))}</span><span>${esc(d.disclaimer || "")}</span></div></div>`;
  box.innerHTML = html;
}

// ---------------- the request ----------------
async function ask(q) {
  busy = true;
  $("send").disabled = true;
  document.querySelectorAll("#quick button").forEach((b) => (b.disabled = true));
  addMsg("user", esc(q));
  $("q").value = "";
  resetTimeline();
  $("verdict").innerHTML = `<div class="empty">Waiting for the agent…</div>`;
  $("bal-arrow").hidden = true;
  if (config.mode === "claude") setStep("s-tool", "active", "thinking…", "violet");

  try {
    // fetch + manual SSE parsing (not EventSource: it would auto-reconnect and could re-run a paid call)
    const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (ev) handle(ev, data ? JSON.parse(data) : {});
      }
    }
  } catch (err) {
    addMsg("error", `Lost connection to the demo server.<small>${esc(err.message)}</small>`);
  } finally {
    endAgentBubble();
    busy = false;
    $("send").disabled = false;
    document.querySelectorAll("#quick button").forEach((b) => (b.disabled = false));
    $("q").focus();
  }
}

function handle(ev, d) {
  switch (ev) {
    case "balance":
      if (d.before != null) $("bal-before").textContent = fmtUsdc(d.before);
      if (d.after != null) {
        $("bal-after").textContent = fmtUsdc(d.after);
        const delta = d.after - d.before;
        $("bal-delta").textContent = delta ? `(${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)})` : "";
        $("bal-arrow").hidden = false;
      }
      break;
    case "agent_text":
      agentSay(d.delta, d.whole);
      break;
    case "tool_call":
      endAgentBubble(); // text before the tool call stays its own bubble
      resetTimeline();
      if (!d.scripted) {
        setStep("s-tool", "done", "✓ tool call", "violet");
        $("s-tool-detail").textContent = `${d.name}(${JSON.stringify(d.input?.address ?? d.input)})`;
      }
      addMsg("toolcall", `<span>${esc(d.name)}(“${esc(d.input?.address ?? "")}”)</span><span class="cost">$0.05</span>`).className = "toolcall";
      break;
    case "step":
      onStep(d);
      break;
    case "verdict":
      renderVerdict(d.data);
      break;
    case "error":
      failActiveStep(d.message);
      if ($("s-tool").classList.contains("active")) setStep("s-tool", "fail", "failed", "red");
      addMsg("error", `${esc(d.message)}${d.detail ? `<small>${esc(d.detail)}</small>` : ""}`);
      break;
    case "done":
      if ($("s-tool").classList.contains("active")) setStep("s-tool", "done", "answered without a paid call", "grey");
      break;
  }
}
