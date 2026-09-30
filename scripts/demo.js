// The "AI agent" buyer: discovers the price via HTTP 402, then pays with x402 and gets the verdict.
// Usage: npm run demo -- "1423 Kearny St"
import "dotenv/config";
import { createBuyer, FriendlyError } from "./x402-client.js";

const address = process.argv.slice(2).join(" ") || "1423 Kearny St";
const line = (s = "") => console.log(s);

try {
  const buyer = await createBuyer({
    apiUrl: process.env.API_URL || "http://localhost:4021",
    privateKey: process.env.BUYER_PRIVATE_KEY,
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    network: process.env.NETWORK || undefined,
  });

  const { data, receipt } = await buyer.check(address, (step, d) => {
    if (step === "request") line(`Agent: GET ${d.url}`);
    if (step === "payment_required") {
      line("Server: HTTP 402 Payment Required");
      line("Payment required:");
      line(`  price   : ${d.price} ${d.currency}  (${d.amount} base units)`);
      line(`  network : ${d.network}${d.networkName !== d.network ? ` (${d.networkName})` : ""}`);
      line(`  payTo   : ${d.payTo}`);
      line(`  asset   : ${d.asset}`);
      line(`  feePayer: ${d.feePayer || "-"} (facilitator covers SOL fees)`);
      line(`  what    : ${d.description}`);
    }
    if (step === "paying") line(`\nAgent: paying ${d.amount} ${d.currency} from ${d.from} ...`);
    if (step === "response") line(`Server: HTTP ${d.status} OK`);
  });

  line("\nVerdict:");
  line(JSON.stringify(data, null, 2));
  if (receipt) {
    line("\nPayment receipt:");
    line(`  success : ${receipt.success}`);
    line(`  payer   : ${receipt.payer}`);
    line(`  network : ${receipt.network}`);
    line(`  tx      : ${receipt.transaction}`);
    if (receipt.explorer) line(`  explorer: ${receipt.explorer}`);
  } else {
    line("\n(no PAYMENT-RESPONSE header returned)");
  }
} catch (err) {
  if (!(err instanceof FriendlyError)) throw err;
  line(err.message);
  if (err.detail) line(`  (${err.detail})`);
  if (err.kind === "api_down") line("Try: npm start");
  process.exit(1);
}
