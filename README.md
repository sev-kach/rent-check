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

## Demo

A local web app for the screen recording and the live pitch. An agent chat is on the left, the x402 protocol steps animate live in the middle, and the purchased verdict card is on the right. The footer shows the agent wallet's USDC balance before and after each call.

```bash
npm run demo:web                                  # http://localhost:3000, pays the live Vercel API
API_URL=http://localhost:4021 npm run demo:web    # or pay a local `npm start` instead
```

It runs **only on your laptop** because it signs payments with `BUYER_PRIVATE_KEY` from `.env`. It listens on 127.0.0.1 and is not part of the Vercel deployment. It pays only on Solana devnet, even though the API also accepts mainnet.

- **Agent: Claude**, used when `ANTHROPIC_API_KEY` is in `.env`. Claude (`claude-sonnet-5-5`, override with `CLAUDE_MODEL`) gets one tool, `check_rent_status(address)`. The system prompt tells it the tool costs $0.05 per call and to use it once per address. The tool runs the x402 payment, and Claude then writes a 3 to 5 sentence answer for the renter. The server caps it at 2 paid calls per question.
- **Agent: script**, used when there is no key (or with `AGENT_MODE=script`). It takes the address out of the question, calls the paid API directly and fills in a templated answer. The badge in the top right shows which mode is running.

Other settings: `DEMO_PORT` (default 3000) and `SOLANA_RPC_URL`. The code is in `scripts/demo-web.js` (server, SSE stream), `scripts/demo-agent.js` (Claude tool loop and script mode), `scripts/x402-client.js` (the x402 buyer, shared with `npm run demo`) and `src/demo-ui/` (the page).

### Demo cases (one click each)

| Button | City records | The story |
|---|---|---|
| **1665 Chestnut St** (Marina) | Built 1950, 24 units, rent-controlled, soft-story retrofit complete. 15 DBI complaints: mold in vacant unit #107 (2013), elevator out 2022–2024, "wildly inconsistent temperatures" (July 2026), no heat (2000). | "It looks perfect in the listing. The agent pays 5 cents and finds mold and a dead elevator." |
| **372 7th Ave Apt 5** (Inner Richmond) | Built 1993, 3 legal units (NC3, store with flats above). Not under SF rent control; state AB 1482 cap likely. | "The listing says Apt 5. The city says the building has 3 legal units." |
| **1824 Anza St** (Inner Richmond) | Built 1912, 3 units, rent-controlled, only one routine inspection on file. | The green light: the tool doesn't flag everything. |

### 60-second recording script

Before recording: run `npm run demo:web`, open http://localhost:3000, put the browser in full screen (View, then Enter Full Screen) at 1920x1080, and click each case once to check that it works (each click spends $0.05 of devnet USDC). Reload the page to start clean.

| Time | Do | Say |
|---|---|---|
| 0:00 | Idle page. Point at the wallet in the footer. | "Renters ask AI agents about apartments, but the facts are buried in city records. rent-check sells them to any agent for 5 cents a call, with no API key and no account." |
| 0:08 | Click **1665 Chestnut St**. | "This listing says rent-controlled and retrofitted. The agent calls our API and gets HTTP 402, Payment Required: 5 cents in USDC on Solana." |
| 0:15 | Point at steps 2 and 3, then the verdict card. | "It signs, pays, and the data comes back. That's a real Solana transaction. Rent-controlled, yes, but mold in unit 107, and the elevator was out from 2022 to 2024." |
| 0:28 | Click **372 7th Ave Apt 5**. Point at the red banner. | "The listing says Apt 5. The city says the building has 3 legal units. That's a question to ask before you sign." |
| 0:40 | Click **1824 Anza St**. | "And it doesn't flag everything: built 1912, rent-controlled, clean record." |
| 0:48 | Click the tx link in step 2 (Solana Explorer opens), then come back. Point at the balance. | "Every answer is paid on-chain, one call at a time. Agents pay for data, and renters get the truth. That's rent-check." |

For the live presentation, if the venue network is unreliable: `AGENT_MODE=script` skips Claude, and `API_URL=http://localhost:4021` with `npm start` skips Vercel. Payments still need Solana devnet and the x402.org facilitator.

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
