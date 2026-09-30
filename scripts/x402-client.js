// Shared x402 buyer: GET /check -> 402 -> sign & pay USDC on Solana -> 200 + receipt.
// Used by scripts/demo.js (CLI) and scripts/demo-web.js (local demo UI).
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/client";

export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

// An error meant to be shown to a person. `kind` lets a UI pick an icon/colour.
export class FriendlyError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind; // api_down | bad_response | no_key | no_funds | seller_not_ready | payment_failed | city_data
    this.detail = detail;
  }
}

// Total USDC (base units) that `owner` holds, plus how many token accounts. null if the RPC is unreachable.
export async function usdcOf(owner, { rpcUrl, mint = USDC_DEVNET } = {}) {
  try {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    };
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const accounts = (await r.json()).result?.value || [];
    return {
      accounts: accounts.length,
      amount: accounts.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.amount), 0),
    };
  } catch {
    return null;
  }
}

// createBuyer({ apiUrl, privateKey, rpcUrl, network }) -> { address, balance(), check(address, onStep) }
// onStep(name, data) fires for: request, payment_required, paying, paid, response.
// Pays only on `network` (default Solana devnet), even if the API also accepts mainnet.
export async function createBuyer({ apiUrl, privateKey, rpcUrl = "https://api.devnet.solana.com", network = DEVNET }) {
  apiUrl = String(apiUrl || "http://localhost:4021").replace(/\/$/, "");
  if (!privateKey) throw new FriendlyError("no_key", "No BUYER_PRIVATE_KEY in .env. Run: npm run wallets");
  const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(privateKey));
  const client = new x402Client().register(network, new ExactSvmScheme(signer, { rpcUrl }));
  const paidFetch = wrapFetchWithPayment(fetch, client);
  const noFunds = `The buyer wallet has no devnet USDC. Get some at faucet.circle.com (choose "Solana Devnet", paste ${signer.address}).`;

  async function check(address, onStep = () => {}) {
    const url = `${apiUrl}/check?address=${encodeURIComponent(address)}`;

    // ---- Step 1: ask without paying -> 402 + payment requirements ----
    onStep("request", { method: "GET", url, path: `/check?address=${encodeURIComponent(address)}` });
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new FriendlyError("api_down", `Can't reach the rent-check API at ${apiUrl}. Is it running?`, err.cause?.code || err.message);
    }
    if (res.status !== 402) {
      const text = await res.text().catch(() => "");
      throw new FriendlyError("bad_response", `Expected HTTP 402 from the API, got ${res.status}.`, text.slice(0, 300));
    }
    let required, option;
    try {
      required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED"));
      option = required.accepts.find((a) => a.network === network);
    } catch (err) {
      throw new FriendlyError("bad_response", "The API sent a 402 without readable payment terms.", err.message);
    }
    if (!option) {
      const offered = required.accepts.map((a) => a.network).join(", ");
      throw new FriendlyError("bad_response", `The API doesn't accept payment on ${network}.`, `offered: ${offered}`);
    }
    const payment = {
      status: 402,
      amount: option.amount,
      price: Number(option.amount) / 1e6,
      currency: option.asset === USDC_DEVNET ? "USDC" : option.asset,
      network: option.network,
      networkName: option.network === DEVNET ? "Solana devnet" : option.network,
      payTo: option.payTo,
      payToUrl: explorerAddr(option.payTo),
      asset: option.asset,
      feePayer: option.extra?.feePayer || null,
      description: required.resource?.description || "",
    };
    onStep("payment_required", payment);

    // ---- Step 2: pre-flight balances, then sign & pay ----
    onStep("paying", { from: signer.address, amount: payment.price, currency: payment.currency });
    const [buyerFunds, sellerFunds] = await Promise.all([
      usdcOf(signer.address, { rpcUrl, mint: option.asset }),
      usdcOf(option.payTo, { rpcUrl, mint: option.asset }),
    ]);
    if (buyerFunds && buyerFunds.amount < Number(option.amount)) throw new FriendlyError("no_funds", noFunds);
    if (sellerFunds && sellerFunds.accounts === 0) {
      throw new FriendlyError(
        "seller_not_ready",
        `The seller ${option.payTo} has no USDC token account yet, so it can't be paid. Run \`npm run wallets\` after giving it devnet SOL.`,
      );
    }

    let paid;
    try {
      paid = await paidFetch(url);
    } catch (err) {
      throw new FriendlyError("payment_failed", "Payment failed before the API answered.", err.message);
    }
    const text = await paid.text();
    if (!paid.ok) {
      const why = paid.headers.get("PAYMENT-REQUIRED");
      let reason = "";
      try {
        reason = why ? decodePaymentRequiredHeader(why).error || "" : "";
      } catch {}
      if (/insufficient|funds|balance/i.test(reason + text)) throw new FriendlyError("no_funds", noFunds);
      if (paid.status === 502) {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {}
        throw new FriendlyError("city_data", "San Francisco's city data is not answering right now. You were not charged. Try again in a minute.", body.error || text.slice(0, 200));
      }
      if (paid.status === 400) throw new FriendlyError("bad_response", "The API didn't accept that address.", text.slice(0, 200));
      throw new FriendlyError(
        "payment_failed",
        "The payment was not accepted, so no data came back (and nothing was charged).",
        reason || `HTTP ${paid.status}: ${text.slice(0, 200)}`,
      );
    }

    let receipt = null;
    const receiptHeader = paid.headers.get("PAYMENT-RESPONSE") || paid.headers.get("X-PAYMENT-RESPONSE");
    if (receiptHeader) {
      try {
        const r = decodePaymentResponseHeader(receiptHeader);
        receipt = {
          success: r.success,
          payer: r.payer || signer.address,
          network: r.network,
          transaction: r.transaction || null,
          explorer: r.transaction ? explorerTx(r.transaction) : null,
        };
      } catch {}
    }
    onStep("paid", receipt || { success: true, payer: signer.address, transaction: null });

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FriendlyError("bad_response", "Paid, but the API answer was not JSON.", text.slice(0, 200));
    }
    onStep("response", { status: paid.status, data });
    return { data, payment, receipt };
  }

  return {
    address: signer.address,
    apiUrl,
    network,
    balance: () => usdcOf(signer.address, { rpcUrl }),
    check,
  };
}
