# Interface contract (all parts must follow this)

## Data function — src/data.js
export async function checkAddress(address: string) -> result object below.
No npm dependencies: use Node's built-in fetch. Source: data.sf.gov (Socrata).

## API
GET /check?address=1423%20Kearny%20St   -> paid, price $0.05 USDC, Solana devnet, x402
GET /health                              -> free, {"ok":true}

## Result JSON
All fields from v1 are kept; new in v2: `unit_check`, `complaints.problems`, `red_flags`, `soft_story`, `rent_control.state_cap`.
{
  "address_query": "372 7th Ave Apt 5",
  "found": true,
  "matched_address": "372 7th Ave",
  "parcel": "1438023",
  "year_built": 1993,
  "units": 3,
  "use": "Multi-Family Residential",
  "zoning": "NC3",
  "rent_control": {
    "status": "likely" | "not_covered" | "exempt_increases" | "unknown",
    "reason": "Built in 1993, after June 13, 1979: not under SF Rent Ordinance, but California AB 1482 statewide cap likely applies (5% + CPI, max 10%/yr); ...",
    "state_cap": "AB 1482 likely"            // only on not_covered, >= 2 units, not a condo, built > 15 years ago
  },
  "unit_check": {
    "claimed_unit": "5" | null,              // parsed from "Apt 5", "#5", "Unit 5", "Apt 107", "#2B"
    "legal_units": 3,
    "flag": true,                            // plain number > legal units, only when legal units <= 10
    "note": "Possible unwarranted unit — listing says Apt 5, city records show 3 legal units."
  },
  "complaints": {
    "total": 7,                              // full DBI history for the parcel(s)
    "problems": 7,                           // total minus "Routine" inspection records
    "open": 0,
    "latest": [{ "date": "2025-04-30", "status": "Not Active", "description": "..." }]   // 3 most recent, redacted
  },
  "red_flags": [                             // [] = no red flags; ordered by priority below
    {
      "category": "illegal_units",
      "label": "possible illegal units",
      "count": 2,
      "latest_date": "2025-04-30",
      "years": "2018, 2025",                 // "2013" | "2000, 2026" | "2022–2024"
      "examples": [{ "date": "2018-02-02", "description": "... (<= 160 chars, redacted)" }]   // max 2
    }
  ],
  "soft_story": { "on_list": true, "status": "Work Complete, CFC Issued", "retrofit_complete": true, "tier": "2" }
             // or { "on_list": false, "status": null, "retrofit_complete": null }; null if the dataset is unreachable
  "verdict": "⚠ Possible unwarranted unit: listing says Apt 5, city shows 3 legal units. Rent-controlled: no (built 1993, after 1979), but state AB 1482 cap likely applies. 3 units. ⚠ Red flags: possible illegal units (2018, 2025), unpermitted work (2015–2025).",
  "sources": ["SF Assessor secured roll 2025 (wv5m-vpq2)", "DBI complaints (gm2e-bten)", "Soft-story retrofit program (beah-shgi)"],
  "disclaimer": "Informational, not legal advice."
}
If not found: { "address_query": ..., "found": false, "verdict": "Address not found in SF property records." }
If DBI complaints are unreachable: complaints = { total: null, problems: null, open: null, latest: [], error }, red_flags = [].

red_flags.category (priority order, keyword rules on the complaint text; "Routine" records are skipped):
illegal_units, mold, elevator, heat_water, pests, unpermitted_work, safety.

Verdict shapes:
- "Rent-controlled: likely. 24 units. ⚠ Red flags: mold (2013), elevator outages (2022–2024), heating / hot water (2000, 2026). Soft-story retrofit: complete."
- "✅ Rent-controlled: likely. 3 units. No problem complaints on record."   (✅ only with no problem complaints, no unit flag, no soft-story non-compliance)

Privacy: phone numbers and emails in complaint text are replaced with "[phone]" / "[email]".
Performance: 1 Assessor query, then complaints + soft-story in parallel (3.5 s timeout each, optional); ~0.5-1.5 s per lookup.
