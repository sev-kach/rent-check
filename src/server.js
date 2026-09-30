// Rent-check API: GET /check?address=... costs $0.05 USDC on Solana devnet, paid via x402 (v2).
import "dotenv/config";
import express from "express";
import { pathToFileURL } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const NETWORK = process.env.NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana devnet
export const PRICE = "$0.05";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
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

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactSvmScheme());

export const app = express();

app.get("/", (req, res) =>
  res.json({
    name: "rent-check",
    about: "Is this San Francisco building rent-controlled? Pay per call with x402.",
    endpoints: { "GET /health": "free", "GET /check?address=1423 Kearny St": `${PRICE} USDC, ${NETWORK}` },
  }),
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use(
  paymentMiddleware(
    {
      "GET /check": {
        accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 120 }],
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
    const result = await checkAddress(address);
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
    console.log(`  paywall: ${PRICE} USDC on ${NETWORK} -> ${PAY_TO}`);
    console.log(`  facilitator: ${FACILITATOR_URL}`);
  });
}
