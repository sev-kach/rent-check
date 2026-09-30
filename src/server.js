// Rent-check API: GET /check?address=... costs $0.05 USDC on Solana (devnet or mainnet), paid via x402 (v2).
import "dotenv/config";
import express from "express";
import { pathToFileURL } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const NETWORK = process.env.NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana devnet
export const PRICE = "$0.05";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
// Mainnet lets real agent wallets (e.g. `pay claude` from pay.sh) pay with real USDC. Set MAINNET=0 to turn off.
export const MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET = process.env.MAINNET !== "0";
const MAINNET_FACILITATOR_URL = process.env.MAINNET_FACILITATOR_URL || "https://facilitator.payai.network";
const PAY_TO = process.env.SELLER_ADDRESS;
if (!PAY_TO) throw new Error("SELLER_ADDRESS is not set. Run `npm run wallets` first (or set it in the environment).");

// Use the real data layer if it exists, else the hard-coded stand-in.
let checkAddress;
try {
  ({ checkAddress } = await import("./data.js"));
} catch (err) {
  if (err.code !== "ERR_MODULE_NOT_FOUND" || !String(err.message).includes("data.js")) throw err;
  ({ checkAddress } = await import("./fake-data.js"));
  console.warn("[rent-check] src/data.js not found, serving FAKE data");
}

// On a cold start the paywall first asks the facilitator which payment kinds it supports. One dropped connection
// there used to fail the whole request with a 500, so retry that lookup (it has no side effects) a few times.
class RetryingFacilitatorClient extends HTTPFacilitatorClient {
  async getSupported() {
    for (let attempt = 1; ; attempt++) {
      try {
        // The client's own timeout is 90s; don't let one hung connection stall a request that long.
        return await Promise.race([
          super.getSupported(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 6s")), 6000)),
        ]);
      } catch (err) {
        if (attempt >= 4) throw err;
        console.warn(`[rent-check] facilitator /supported failed (attempt ${attempt}), retrying:`, err.message);
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  }
}

const facilitators = [new RetryingFacilitatorClient({ url: FACILITATOR_URL, timeoutMs: 25000 })];
if (MAINNET) facilitators.push(new RetryingFacilitatorClient({ url: MAINNET_FACILITATOR_URL, timeoutMs: 25000 }));
const resourceServer = new x402ResourceServer(facilitators).register(NETWORK, new ExactSvmScheme());
if (MAINNET) resourceServer.register(MAINNET_NETWORK, new ExactSvmScheme());

const accepts = [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 }];
if (MAINNET) accepts.push({ scheme: "exact", price: PRICE, network: MAINNET_NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 });

export const app = express();

const ABOUT = {
  name: "rent-check",
  about: "Is this San Francisco building rent-controlled? Pay per call with x402.",
  endpoints: { "GET /health": "free", "GET /check?address=300 Anzavista Ave": `${PRICE} USDC via x402 on ${[NETWORK, MAINNET && MAINNET_NETWORK].filter(Boolean).join(" or ")}` },
  video: "https://www.youtube.com/watch?v=gvvUIVtCrL4",
  code: "https://github.com/sev-kach/rent-check",
};

// Agents get JSON; a person opening the link in a browser gets a one-screen explanation.
const HOME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rent-check</title><style>
body{margin:0;background:#0e1319;color:#e8edf2;font:17px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 20px}h1{font-size:40px;margin:0 0 4px}.sub{color:#93a1b2;margin:0 0 28px}
a{color:#5bd17a}code,pre{font:14px ui-monospace,Menlo,monospace;background:#171e27;border:1px solid #263140;border-radius:8px}
code{padding:2px 6px}pre{padding:14px;overflow-x:auto;white-space:pre-wrap}.links a{display:inline-block;margin:0 16px 8px 0;font-weight:600}
</style></head><body><main>
<h1>rent-check</h1><p class="sub">City records for renters, sold to AI agents for 5 cents a call.</p>
<p class="links"><a href="${ABOUT.video}">▶ Demo video</a><a href="${ABOUT.code}">GitHub</a></p>
<p>An AI agent sends a San Francisco address, pays <b>$0.05 in USDC on Solana</b> via <a href="https://x402.org">x402</a>, and gets back:
is the building rent-controlled, how many legal units it has, how big the units really are, and red flags from city building complaints.
No account, no API key: the agent pays per request from its own wallet.</p>
<p>Try it: this request answers <b>402 Payment Required</b> until an agent pays.</p>
<pre>GET /check?address=300 Anzavista Ave</pre>
<p>With a wallet-enabled agent (<a href="https://github.com/solana-foundation/pay">pay.sh</a>, Solana devnet):</p>
<pre>pay curl "${"https://rent-check-eight.vercel.app"}/check?address=300%20Anzavista%20Ave"</pre>
<p class="sub">Data: SF Assessor roll, DBI complaints, soft-story retrofit list (DataSF). Informational, not legal advice.</p>
</main></body></html>`;

app.get("/", (req, res) => (req.accepts(["json", "html"]) === "html" ? res.type("html").send(HOME_HTML) : res.json(ABOUT)));

app.get("/health", (req, res) => res.json({ ok: true }));

// Express answers HEAD with the GET handler, but the paywall only guards GET: block HEAD so /check never runs unpaid.
app.head("/check", (req, res) => res.set("Allow", "GET").status(405).end());

// x402 puts the settlement (tx signature) only in the PAYMENT-RESPONSE header, which many agent tools never show.
// Copy it into the JSON body as `payment_receipt`. Registered before the paywall so it wraps res.end outermost
// and runs when the paywall replays the buffered response, after settlement has set the header.
app.use("/check", (req, res, next) => {
  const end = res.end.bind(res);
  res.end = function (chunk, ...rest) {
    const header = res.getHeader("PAYMENT-RESPONSE") || res.getHeader("X-PAYMENT-RESPONSE");
    if (header && chunk && res.statusCode === 200 && String(res.getHeader("Content-Type")).includes("json")) {
      try {
        const settle = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
        const body = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        const devnet = String(settle.network).includes("EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
        body.payment_receipt = {
          paid: `${PRICE.replace("$", "")} USDC`,
          network: devnet ? "Solana devnet" : "Solana mainnet",
          transaction: settle.transaction,
          payer: settle.payer,
          pay_to: PAY_TO,
          explorer: `https://explorer.solana.com/tx/${settle.transaction}${devnet ? "?cluster=devnet" : ""}`,
          solscan: `https://solscan.io/tx/${settle.transaction}${devnet ? "?cluster=devnet" : ""}`,
          status: "settled on-chain (no further lookup needed)",
        };
        if (typeof body.verdict === "string") body.verdict += ` Paid ${body.payment_receipt.paid} on ${body.payment_receipt.network}, Solscan receipt: ${body.payment_receipt.solscan}`;
        chunk = JSON.stringify(body);
        res.setHeader("Content-Length", Buffer.byteLength(chunk));
      } catch {
        // Leave the response untouched if either side isn't the JSON we expect.
      }
    }
    return end(chunk, ...rest);
  };
  next();
});

app.use(
  paymentMiddleware(
    {
      "GET /check": {
        accepts,
        description: "Rent-control verdict for a San Francisco address (Assessor roll + DBI complaints)",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/check", async (req, res) => {
  const address = String(req.query.address || "").trim();
  if (!address) return res.status(400).json({ error: "Missing ?address=, e.g. /check?address=1423%20Kearny%20St" });
  try {
    const result = await checkAddress(address, { sqft: req.query.sqft });
    // City data unreachable: answer with an error status so x402 skips settlement (agent is not charged).
    if (result.error && !result.found) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error("[rent-check] lookup failed:", err);
    res.status(502).json({ error: "City data lookup failed", detail: err.message });
  }
});

// Run a local server only when executed directly (Vercel imports `app` via api/index.js).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.PORT) || 4021;
  app.listen(port, () => {
    console.log(`rent-check listening on http://localhost:${port}`);
    console.log(`  paywall: ${PRICE} USDC on ${accepts.map((a) => a.network).join(" | ")} -> ${PAY_TO}`);
    console.log(`  facilitators: ${FACILITATOR_URL}${MAINNET ? ", " + MAINNET_FACILITATOR_URL : ""}`);
  });
}

// Vercel may load this file directly as a function (e.g. for "/"), which needs a default export.
export default app;
