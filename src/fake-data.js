// Stand-in for src/data.js so the paywall can be demoed before the real data layer lands.
// Same shape as CONTRACT.md; values mirror the real 1423 Kearny St record.
export async function checkAddress(address) {
  return {
    address_query: address,
    found: true,
    matched_address: "1413-1423 Kearny St",
    parcel: "0104008",
    year_built: 1906,
    units: 6,
    use: "Multi-Family Residential",
    zoning: "RH3",
    rent_control: {
      status: "likely",
      reason: "Multi-unit residential building built before June 13, 1979 (SF Rent Ordinance).",
    },
    complaints: {
      total: 4,
      open: 0,
      latest: [{ date: "2015-04-01", status: "Not Active", description: "Sample complaint (fake data)" }],
    },
    verdict: "Rent-controlled: likely. Units: 6. Open complaints: none.",
    sources: ["FAKE DATA (src/data.js not present yet)"],
    disclaimer: "Informational, not legal advice.",
  };
}
