# Interface contract (all parts must follow this)

## Data function — src/data.js
export async function checkAddress(address: string) -> result object below.
No npm dependencies: use Node's built-in fetch. Source: data.sf.gov (Socrata).

## API
GET /check?address=1423%20Kearny%20St   -> paid, price $0.05 USDC, Solana devnet, x402
GET /health                              -> free, {"ok":true}

## Result JSON
{
  "address_query": "1423 Kearny St",
  "found": true,
  "matched_address": "1413-1423 Kearny St",
  "parcel": "0104008",
  "year_built": 1906,
  "units": 6,
  "use": "Multi-Family Residential",
  "zoning": "RH3",
  "rent_control": { "status": "likely" | "not_covered" | "exempt_increases" | "unknown", "reason": "..." },
  "complaints": { "total": 4, "open": 0, "latest": [{ "date": "2015-04-01", "status": "Not Active", "description": "..." }] },
  "verdict": "Rent-controlled: likely. Units: 6. Open complaints: none.",
  "sources": ["SF Assessor secured roll 2025 (wv5m-vpq2)", "DBI complaints (gm2e-bten)"],
  "disclaimer": "Informational, not legal advice."
}
If not found: { "address_query": ..., "found": false, "verdict": "Address not found in SF property records." }
