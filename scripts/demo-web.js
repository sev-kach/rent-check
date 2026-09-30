// Local demo UI for the screen recording: chat-style agent on the left, live x402 timeline on the right.
// Runs on this laptop only (it holds BUYER_PRIVATE_KEY). Never deploy it.
//   npm run demo:web                                  -> http://localhost:3000, paid API = Vercel deployment
//   API_URL=http://localhost:4021 npm run demo:web    -> against a local `npm start`
// If ANTHROPIC_API_KEY is set, Claude is the agent (tool: check_rent_status, $0.05 per call). Otherwise "script" mode.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuyer, FriendlyError, USDC_DEVNET } from "./x402-client.js";
import { runClaude, extractAddress, templateSummary } from "./demo-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT) || 3000;
const API_URL = (process.env.DEMO_API_URL || process.env.API_URL || "https://rent-check-eight.vercel.app").replace(/\/$/, "");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const forced = (process.env.AGENT_MODE || "").toLowerCase(); // "script" forces script mode even with a key
const MODE = process.env.ANTHROPIC_API_KEY && forced !== "script" ? "claude" : "script";

const buyer = await createBuyer({ apiUrl: API_URL, privateKey: process.env.BUYER_PRIVATE_KEY, rpcUrl: RPC_URL, network: process.env.NETWORK || undefined });

let anthropic = null;
if (MODE === "claude") {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  anthropic = new Anthropic();
}

// ---------------- HTTP ----------------

const app = express();
// Only answer requests addressed to localhost (blocks DNS-rebinding pages from driving the wallet).
app.use((req, res, next) => (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "") ? next() : res.status(403).end()));
app.use(express.json());
app.use(express.static(path.join(here, "..", "src", "demo-ui")));

app.get("/api/config", (req, res) =>
  res.json({
    mode: MODE,
    model: MODE === "claude" ? MODEL : null,
    apiUrl: API_URL,
    buyer: buyer.address,
    network: "Solana devnet",
    asset: USDC_DEVNET,
  }),
);

app.get("/api/balance", async (req, res) => {
  const b = await buyer.balance();
  res.json(b ? { usdc: b.amount / 1e6 } : { usdc: null });
});

let busy = false;

// Streams one question as Server-Sent Events. POST {q} with content-type application/json. The UI uses fetch() (no EventSource auto-reconnect,
// which could re-run a paid call).
async function ask(req, res) {
  // JSON POST only: a cross-site page can't send one without a CORS preflight (which this server never approves),
  // so another tab in the browser can't make this wallet pay.
  if (!req.is("application/json")) return res.status(415).json({ error: "POST JSON: {\"q\": \"...\"}" });
  const q = String(req.body?.q ?? "").trim().slice(0, 500);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const end = () => {
    send("done", {});
    res.end();
  };
  if (!q) {
    send("error", { kind: "input", message: "Type an address or a question first." });
    return end();
  }
  if (busy) {
    send("error", { kind: "busy", message: "The agent is still working on the previous question." });
    return end();
  }
  busy = true;
  try {
    send("start", { mode: MODE, model: MODE === "claude" ? MODEL : null, question: q });
    const before = await buyer.balance();
    send("balance", { before: before ? before.amount / 1e6 : null });
    let paidOnce = false;

    const doCheck = async (address) => {
      const { data } = await buyer.check(address, (step, d) => send("step", { step, ...d }));
      paidOnce = true;
      send("verdict", { data });
      return data;
    };

    if (MODE === "claude") {
      const toolCheck = async (address) => {
        try {
          return await doCheck(address);
        } catch (err) {
          send("error", friendly(err)); // show it in the timeline; Claude also gets it as a tool error
          throw err;
        }
      };
      await runClaude({ anthropic, model: MODEL, question: q, send, doCheck: toolCheck });
    } else {
      const address = extractAddress(q);
      if (!address) {
        send("error", { kind: "input", message: "I couldn't find an address in that. Try something like \"1824 Anza St\"." });
      } else {
        send("tool_call", { name: "check_rent_status", input: { address }, scripted: true });
        try {
          const data = await doCheck(address);
          send("agent_text", { delta: templateSummary(data), whole: true });
        } catch (err) {
          send("error", friendly(err));
        }
      }
    }

    if (paidOnce && before) {
      // Devnet balances can lag the settlement by a second or two: poll briefly for the change.
      let after = null;
      for (let i = 0; i < 6; i++) {
        after = await buyer.balance();
        if (after && after.amount !== before.amount) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (after) send("balance", { before: before.amount / 1e6, after: after.amount / 1e6 });
    }
  } catch (err) {
    console.error("[demo-web]", err);
    send("error", friendly(err));
  } finally {
    busy = false;
    end();
  }
}

function friendly(err) {
  if (err instanceof FriendlyError) return { kind: err.kind, message: err.message, detail: err.detail };
  if (err?.status === 401) return { kind: "claude", message: "Claude rejected the API key (ANTHROPIC_API_KEY). Fix it, or run with AGENT_MODE=script." };
  if (err?.status === 429 || err?.status === 529) return { kind: "claude", message: "Claude is busy right now. Try again in a few seconds." };
  if (err?.status) return { kind: "claude", message: `Claude API error ${err.status}.`, detail: err.message };
  return { kind: "unknown", message: "Something went wrong.", detail: err?.message };
}

app.post("/api/ask", ask);

// Bind to localhost only: this server can spend the buyer wallet's USDC.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`rent-check demo UI: http://localhost:${PORT}`);
  console.log(`  agent : ${MODE === "claude" ? `Claude (${MODEL})` : "script (set ANTHROPIC_API_KEY for Claude)"}`);
  console.log(`  API   : ${API_URL}`);
  console.log(`  buyer : ${buyer.address}`);
});

