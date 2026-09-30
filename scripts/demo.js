// The "AI agent" buyer: discovers the price via HTTP 402, then pays with x402 and gets the verdict.
// Usage: npm run demo -- "1423 Kearny St"
import "dotenv/config";
import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const API_URL = (process.env.API_URL || "http://localhost:4021").replace(/\/$/, "");
const address = process.argv.slice(2).join(" ") || "1423 Kearny St";
const url = `${API_URL}/check?address=${encodeURIComponent(address)}`;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const line = (s = "") => console.log(s);

// ---- Step A: ask without paying -> 402 + payment requirements ----
line(`Agent: GET ${url}`);
let res;
try {
  res = await fetch(url);
} catch (err) {
  line(`Cannot reach ${API_URL} (${err.cause?.code || err.message}). Is the server running? Try: npm start`);
  process.exit(1);
}
line(`Server: HTTP ${res.status} ${res.statusText}`);
if (res.status !== 402) {
  line(await res.text());
  process.exit(1);
}
const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED"));
const option = required.accepts[0];
const decimals = 6; // USDC
line("Payment required:");
line(`  price   : ${Number(option.amount) / 10 ** decimals} USDC  (${option.amount} base units)`);
line(`  network : ${option.network}${option.network.endsWith("EtWTRABZaYq6iMfeYKouRu166VU2xqa1") ? " (Solana devnet)" : ""}`);
line(`  payTo   : ${option.payTo}`);
line(`  asset   : ${option.asset}${option.asset === USDC_DEVNET ? " (USDC)" : ""}`);
line(`  feePayer: ${option.extra?.feePayer || "-"} (facilitator covers SOL fees)`);
line(`  what    : ${required.resource?.description || ""}`);

// ---- Step B: pay with the buyer wallet and retry ----
if (!process.env.BUYER_PRIVATE_KEY) {
  line("\nNo BUYER_PRIVATE_KEY in .env. Run: npm run wallets");
  process.exit(1);
}
const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(process.env.BUYER_PRIVATE_KEY));

// USDC token accounts of `owner` -> { accounts, amount } in base units, or null if the RPC is unreachable.
async function usdcOf(owner) {
  try {
    const body = { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: option.asset }, { encoding: "jsonParsed" }] };
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const accounts = (await r.json()).result?.value || [];
    return { accounts: accounts.length, amount: accounts.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.amount), 0) };
  } catch {
    return null; // unknown; let the payment attempt decide
  }
}
const NO_USDC = `Buyer wallet has no devnet USDC — get some at faucet.circle.com (choose "Solana Devnet", paste ${signer.address})`;

line(`\nAgent: paying from ${signer.address} ...`);
const [buyerFunds, sellerFunds] = await Promise.all([usdcOf(signer.address), usdcOf(option.payTo)]);
if (buyerFunds && buyerFunds.amount < Number(option.amount)) {
  line(NO_USDC);
  process.exit(1);
}
if (sellerFunds && sellerFunds.accounts === 0) {
  line(`Seller ${option.payTo} has no USDC token account yet, so it cannot receive USDC.`);
  line("Fix: run `npm run wallets` once the seller has a little devnet SOL (faucet.solana.com), or send it any USDC from faucet.circle.com.");
  process.exit(1);
}

const client = new x402Client().register("solana:*", new ExactSvmScheme(signer, { rpcUrl: RPC_URL }));
const paidFetch = wrapFetchWithPayment(fetch, client);
let paid;
try {
  paid = await paidFetch(url);
} catch (err) {
  line(`Payment failed: ${err.message}`);
  process.exit(1);
}
line(`Server: HTTP ${paid.status} ${paid.statusText}`);
const text = await paid.text();
if (!paid.ok) {
  const why = paid.headers.get("PAYMENT-REQUIRED");
  const reason = why ? decodePaymentRequiredHeader(why).error : "";
  if (/insufficient|funds|balance/i.test(reason + text)) line(NO_USDC);
  else line(`Payment not accepted: ${reason || text}`);
  if (/simulation_failed/.test(reason)) line("(Usually: buyer lacks devnet USDC, or the seller has no USDC token account yet.)");
  process.exit(1);
}

line("\nVerdict:");
line(JSON.stringify(JSON.parse(text), null, 2));

const receiptHeader = paid.headers.get("PAYMENT-RESPONSE") || paid.headers.get("X-PAYMENT-RESPONSE");
if (receiptHeader) {
  const receipt = decodePaymentResponseHeader(receiptHeader);
  line("\nPayment receipt:");
  line(`  success : ${receipt.success}`);
  line(`  payer   : ${receipt.payer || signer.address}`);
  line(`  network : ${receipt.network}`);
  line(`  tx      : ${receipt.transaction}`);
  if (receipt.transaction) line(`  explorer: ${explorer(receipt.transaction)}`);
} else {
  line("\n(no PAYMENT-RESPONSE header returned)");
}
