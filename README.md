# rent-check

**Live API (Solana devnet):** https://rent-check-eight.vercel.app — `GET /check?address=1423%20Kearny%20St` returns HTTP 402 until paid ($0.05 USDC via x402).
Try it: `API_URL=https://rent-check-eight.vercel.app npm run demo -- "1423 Kearny St"`

**Is this San Francisco building rent-controlled?** A pay-per-call API for AI agents. An agent sends an address, pays $0.05 in USDC via [x402](https://x402.org) on Solana devnet, and gets back a verdict with the evidence behind it.

Why would an agent pay for this instead of scraping it itself? The public data is there, but it is awkward to use. The Assessor roll does not say "1423 Kearny St". It says `1423 1413 KEARNY              ST0000`: a house-number range with the high number first, a padded street name, a suffix code and a unit number. Numbered streets appear both as `03RD AV` and as `3RD ST`, and a condo tower is 112 separate parcels. A good answer needs two datasets (the Assessor secured roll and the DBI complaints), and then SF's rent rules on top: buildings first occupied after June 1979 are not covered, and single-family homes and condos are exempt from rent-increase limits under Costa-Hawkins. rent-check handles all of this and returns one clean JSON answer for five cents, without an API key or an account.

## Quick start

Requires Node 20 or newer.

```bash
npm install
npm run wallets          # creates buyer + seller devnet keypairs in .env and prints what is still missing
```

**Faucet step (manual, once):** go to https://faucet.circle.com, choose **Solana Devnet** and request USDC for:

- the **buyer** address that `npm run wallets` printed. It pays for the calls; 10 USDC is plenty. It needs no SOL because the facilitator pays the fees.
- the **seller** address. The seller must have a USDC token account before it can be paid, and receiving faucet USDC creates that account. The other way: get devnet SOL at https://faucet.solana.com for the seller, then run `npm run wallets` again and it creates the account itself.

```bash
npm start                               # http://localhost:4021
npm run demo -- "1423 Kearny St"        # agent: gets the 402, pays, prints the verdict and the Solana tx link
npm run test:data                       # tests the live data layer on 5 addresses (no payment)
```

## API

| Endpoint | Price | Response |
|---|---|---|
| `GET /health` | free | `{"ok":true}` |
| `GET /` | free | service description |
| `GET /check?address=1423%20Kearny%20St` | $0.05 USDC, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) | verdict JSON (below) |

A call to `/check` without payment returns **HTTP 402**. The `PAYMENT-REQUIRED` header holds the requirements as base64 JSON (x402 v2): scheme `exact`, amount `50000` (0.05 USDC), asset `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (devnet USDC), `payTo` = the seller, and `extra.feePayer` = the facilitator. Any x402 v2 client, such as `@x402/fetch` with `@x402/svm`, can pay it automatically. The receipt comes back in the `PAYMENT-RESPONSE` header.

You are charged only for a successful answer. A missing address (400) or unreachable city data (502) means no settlement.

```json
{
  "address_query": "1423 Kearny St",
  "found": true,
  "matched_address": "1413-1423 Kearny St",
  "parcel": "0104008",
  "year_built": 1906,
  "units": 6,
  "use": "Multi-Family Residential",
  "zoning": "RH3",
  "rent_control": { "status": "likely", "reason": "..." },
  "complaints": { "total": 10, "open": 0, "latest": [{ "date": "...", "status": "Not Active", "description": "..." }] },
  "verdict": "Rent-controlled: likely. Units: 6. Open complaints: none.",
  "sources": ["SF Assessor secured roll 2025 (wv5m-vpq2)", "DBI complaints (gm2e-bten)"],
  "disclaimer": "Informational, not legal advice."
}
```

`rent_control.status` is one of:

- `likely`: built before 1979 with 2 or more units.
- `not_covered`: built in 1979 or later.
- `exempt_increases`: a single-family home or a condo. Rent-increase limits do not apply, but eviction protections may.
- `unknown`: no build year, or no residential units.

If the address is not found, the response is `{"address_query": "...", "found": false, "verdict": "Address not found in SF property records."}`.

Data comes live from `data.sf.gov` (Socrata): Assessor roll `wv5m-vpq2` and DBI complaints `gm2e-bten`. Neither needs a token.

## Deploy (Vercel)

`api/index.js` exports the Express app, and `vercel.json` routes every path to it.

```bash
npx vercel login
npx vercel deploy          # add --prod when ready
```

Set these environment variables in Vercel (Project, then Settings, then Environment Variables):

| Variable | Value |
|---|---|
| `SELLER_ADDRESS` | the seller public key from `.env` (required) |
| `NETWORK` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| `FACILITATOR_URL` | `https://x402.org/facilitator` |

Do **not** upload private keys to Vercel, because the server only needs the public `SELLER_ADDRESS`. Then point the demo at the deployment:

```bash
API_URL=https://<your-deployment>.vercel.app npm run demo -- "1423 Kearny St"
```

## Files

- `src/data.js`: address parsing, Assessor lookup, DBI complaints, rent rules (`checkAddress`).
- `src/server.js`: the Express app with the x402 paywall.
- `api/index.js`: the Vercel entry point.
- `scripts/wallets.js`: creates and funds the devnet wallets.
- `scripts/demo.js`: the agent buyer.
- `scripts/test-data.js`: data-layer checks.

Secrets live in `.env` and `wallets/`. Both are gitignored.

*Informational, not legal advice.*
