// Creates buyer + seller Solana devnet wallets (once), stores them in .env, funds what it can.
// Usage: npm run wallets
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

const ENV_FILE = new URL("../.env", import.meta.url);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC
const rpc = createSolanaRpc(RPC_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- .env helpers: only add keys that are missing, never overwrite ---
function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
function addEnv(key, value, env) {
  if (env[key]) return;
  const prefix = existsSync(ENV_FILE) && !readFileSync(ENV_FILE, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(ENV_FILE, `${prefix}${key}=${value}\n`);
  env[key] = value;
}

// 64-byte Solana secret key (32-byte seed + 32-byte public key), base58 — the format
// @solana/kit's createKeyPairSignerFromBytes (used by the x402 client) expects.
function newSecretKeyBase58() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
}
const signerFrom = (b58) => createKeyPairSignerFromBytes(getBase58Encoder().encode(b58));

async function solBalance(addr) {
  const { value } = await rpc.getBalance(address(addr)).send();
  return Number(value) / 1e9;
}
async function usdcBalance(owner) {
  const [ata] = await findAssociatedTokenPda({ mint: USDC_MINT, owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const info = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
  if (!info.value) return { ata, exists: false, amount: 0 };
  const { value } = await rpc.getTokenAccountBalance(ata).send();
  return { ata, exists: true, amount: Number(value.uiAmountString) };
}

async function airdrop(addr, sol) {
  try {
    const sig = await rpc.requestAirdrop(address(addr), BigInt(sol * 1e9)).send();
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return true;
    }
    console.log(`  airdrop sent (${sig}) but not confirmed yet`);
    return true;
  } catch (err) {
    console.log(`  airdrop failed: ${err.context?.__serverMessage || err.message}`.slice(0, 200));
    return false;
  }
}

// The payment transfers USDC into the seller's associated token account, so it must exist.
async function ensureSellerUsdcAccount(seller) {
  const signer = await signerFrom(seller.key);
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: signer.address, mint: USDC_MINT });
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
  const sig = getSignatureFromTransaction(tx);
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    if (value[0]?.confirmationStatus) return sig;
  }
  return sig;
}

async function checkFacilitatorPaysFees(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/supported`);
    const { kinds = [] } = await res.json();
    const kind = kinds.find((k) => k.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" && k.scheme === "exact");
    return kind?.extra?.feePayer || null;
  } catch {
    return null;
  }
}

// --- main ---
const env = readEnv();
addEnv("NETWORK", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", env);
addEnv("FACILITATOR_URL", "https://x402.org/facilitator", env);
if (!env.BUYER_PRIVATE_KEY) addEnv("BUYER_PRIVATE_KEY", newSecretKeyBase58(), env);
if (!env.SELLER_PRIVATE_KEY) addEnv("SELLER_PRIVATE_KEY", newSecretKeyBase58(), env);
const buyer = { key: env.BUYER_PRIVATE_KEY, address: (await signerFrom(env.BUYER_PRIVATE_KEY)).address };
const seller = { key: env.SELLER_PRIVATE_KEY, address: (await signerFrom(env.SELLER_PRIVATE_KEY)).address };
addEnv("BUYER_ADDRESS", buyer.address, env);
addEnv("SELLER_ADDRESS", seller.address, env);

console.log("Wallets (Solana devnet), saved in .env");
console.log(`  buyer  (AI agent, pays): ${buyer.address}`);
console.log(`  seller (API, gets paid): ${seller.address}`);

const feePayer = await checkFacilitatorPaysFees(env.FACILITATOR_URL);
console.log(
  feePayer
    ? `\nFacilitator ${env.FACILITATOR_URL} pays Solana tx fees (feePayer ${feePayer}) -> buyer needs only USDC, no SOL.`
    : `\nCould not confirm the facilitator pays fees; buyer may need some devnet SOL.`,
);

// Seller needs a little SOL once, to open its USDC token account (rent ~0.002 SOL).
let sellerUsdc = await usdcBalance(seller.address);
if (!sellerUsdc.exists) {
  if ((await solBalance(seller.address)) < 0.003) {
    console.log("\nRequesting 1 devnet SOL for seller (to open its USDC account)...");
    await airdrop(seller.address, 1);
  }
  if ((await solBalance(seller.address)) >= 0.003) {
    try {
      const sig = await ensureSellerUsdcAccount(seller);
      console.log(`  seller USDC account created: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (err) {
      console.log(`  could not create seller USDC account: ${err.message}`);
    }
    sellerUsdc = await usdcBalance(seller.address);
  }
}

const buyerUsdc = await usdcBalance(buyer.address);
console.log("\nBalances");
console.log(`  buyer : ${await solBalance(buyer.address)} SOL, ${buyerUsdc.amount} USDC`);
console.log(`  seller: ${await solBalance(seller.address)} SOL, ${sellerUsdc.amount} USDC (USDC account ${sellerUsdc.exists ? "ready" : "MISSING"})`);

const todo = [];
if (buyerUsdc.amount < 0.05)
  todo.push(`Get devnet USDC for the BUYER: https://faucet.circle.com -> "Solana Devnet" -> paste ${buyer.address}`);
if (!sellerUsdc.exists)
  todo.push(
    `Seller USDC account missing (SOL airdrop was rate-limited). Either get devnet SOL at https://faucet.solana.com for ${seller.address} and re-run \`npm run wallets\`, ` +
      `or send any devnet USDC to it from https://faucet.circle.com (that also opens the account).`,
  );
if (todo.length) {
  console.log("\nTODO (human):");
  todo.forEach((t) => console.log(`  - ${t}`));
} else {
  console.log("\nAll set: run `npm start`, then `npm run demo`.");
}
