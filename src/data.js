// San Francisco rent-control lookup from open city data (data.sf.gov, Socrata).
// No dependencies: uses Node's built-in fetch.

const BASE = 'https://data.sf.gov/resource';
const ASSESSOR = 'wv5m-vpq2'; // Assessor secured roll
const COMPLAINTS = 'gm2e-bten'; // DBI complaints
const TIMEOUT_MS = 8000;
const FALLBACK_YEAR = '2025';
const DISCLAIMER = 'Informational, not legal advice.';

// ---------- HTTP ----------

async function soql(dataset, params) {
  const url = `${BASE}/${dataset}.json?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${dataset} HTTP ${res.status}`);
  return res.json();
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // SoQL string literal

// ---------- Address parsing ----------

const SUFFIXES = {
  ST: 'ST', STREET: 'ST', AV: 'AV', AVE: 'AV', AVENUE: 'AV', BL: 'BL', BLVD: 'BL',
  BOULEVARD: 'BL', DR: 'DR', DRIVE: 'DR', WY: 'WY', WAY: 'WY', TE: 'TE', TER: 'TE',
  TERRACE: 'TE', CT: 'CT', COURT: 'CT', PL: 'PL', PLACE: 'PL', LN: 'LN', LANE: 'LN',
  CR: 'CR', CIR: 'CR', CIRCLE: 'CR', HW: 'HW', HWY: 'HW', HIGHWAY: 'HW', RD: 'RD',
  ROAD: 'RD', PZ: 'PZ', PLZ: 'PZ', PLAZA: 'PZ', AL: 'AL', ALY: 'AL', ALLEY: 'AL',
  RW: 'RW', ROW: 'RW', WK: 'WK', WALK: 'WK',
};
const SUFFIX_LABEL = {
  ST: 'St', AV: 'Ave', BL: 'Blvd', DR: 'Dr', WY: 'Way', TE: 'Ter', CT: 'Ct', PL: 'Pl',
  LN: 'Ln', CR: 'Cir', HW: 'Hwy', RD: 'Rd', PZ: 'Plz', AL: 'Aly', RW: 'Row', WK: 'Walk',
  PK: 'Park',
};
const STREET_ALIASES = { EMBARCADERO: 'THE EMBARCADERO' };

// "NINETEENTH" / "TWENTY FIRST" -> 19 / 21 (SF numbered streets and avenues go up to 48th)
const ORDINALS = (() => {
  const ones = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH'];
  const teens = ['TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH', 'SIXTEENTH', 'SEVENTEENTH', 'EIGHTEENTH', 'NINETEENTH'];
  const map = {};
  ones.forEach((w, i) => (map[w] = i + 1));
  teens.forEach((w, i) => (map[w] = i + 10));
  [['TWENTY', 20], ['THIRTY', 30], ['FORTY', 40]].forEach(([t, n]) => {
    map[t.replace(/Y$/, 'IETH')] = n;
    ones.forEach((w, i) => (map[`${t} ${w}`] = n + i + 1));
  });
  return map;
})();

// "1423 kearny street" -> { number: 1423, streets: ["KEARNY"], suffix: "ST" }
// streets holds spelling variants: the roll writes numbered streets both as "03RD" and "3RD".
export function parseAddress(input) {
  let s = String(input || '').split(',')[0].toUpperCase().trim();
  // "... St San Francisco CA 94133" / "... St CA 94133" without commas (keep "100 California")
  s = s.replace(/\s+(SAN FRANCISCO|SF)\b.*$/, '').replace(/(\s+CA(LIFORNIA)?)?\s+\d{5}(-\d{4})?$/, '');
  s = s.replace(/\s(#|APT\.?|UNIT|STE\.?|SUITE)\s*\S+$/, ''); // drop unit
  s = s.replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(\d+)[A-Z]?(?:\s*-\s*\d+[A-Z]?)?\s+(.+)$/);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  const words = m[2].replace(/-/g, ' ').split(' ');
  let suffix = null;
  if (words.length > 1 && SUFFIXES[words.at(-1)]) suffix = SUFFIXES[words.pop()];
  let street = words.join(' ');
  if (ORDINALS[street]) street = `${ORDINALS[street]}${ordinalEnding(ORDINALS[street])}`;
  street = STREET_ALIASES[street] || street;
  if (!number || number > 9999 || !street) return null;
  let streets = [street];
  const num = street.match(/^0*(\d+)(ST|ND|RD|TH)$/);
  if (num) streets = [...new Set([num[1] + num[2], num[1].padStart(2, '0') + num[2]])];
  return { number, streets: streets.map((x) => x.slice(0, 20)), suffix };
}

function ordinalEnding(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'TH';
  return { 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH';
}

// "1423 1413 KEARNY              ST0000" -> { hi: 1423, lo: 1413, street, suffix }
function parseLocation(loc) {
  return {
    hi: parseInt(loc.slice(0, 4), 10) || 0,
    lo: parseInt(loc.slice(5, 9), 10) || 0,
    street: loc.slice(10, 30).trim(),
    suffix: loc.slice(30, 32).trim(),
  };
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

function displayAddress(loc) {
  const street = loc.street.replace(/^0(\d)/, '$1'); // "03RD" -> "3RD"
  const range = loc.hi && loc.hi !== loc.lo ? `${Math.min(loc.lo, loc.hi)}-${Math.max(loc.lo, loc.hi)}` : `${loc.lo}`;
  const sfx = SUFFIX_LABEL[loc.suffix] || '';
  return `${range} ${titleCase(street)}${sfx ? ' ' + sfx : ''}`;
}

// ---------- Assessor roll ----------

let latestYearPromise;
function latestYear() {
  latestYearPromise ??= soql(ASSESSOR, { $select: 'max(closed_roll_year) AS y' })
    .then((r) => r[0]?.y || FALLBACK_YEAR)
    .catch(() => {
      latestYearPromise = undefined; // retry next time
      return FALLBACK_YEAR;
    });
  return latestYearPromise;
}

async function findRows(addr, year) {
  const n = q(String(addr.number).padStart(4, '0'));
  const lo = 'substring(property_location,6,4)';
  const hi = 'substring(property_location,1,4)';
  const where = [
    `closed_roll_year=${q(year)}`,
    `substring(property_location,11,20) in (${addr.streets.map((x) => q(x.padEnd(20))).join(',')})`,
    `(${lo}=${n} OR ${hi}=${n} OR (${lo}<=${n} AND ${hi}>=${n}) OR (${hi}!='0000' AND ${hi}<=${n} AND ${lo}>=${n}))`,
  ].join(' AND ');
  const rows = await soql(ASSESSOR, {
    $select: 'property_location,parcel_number,year_property_built,number_of_units,use_definition,property_class_code_definition,zoning_code',
    $where: where,
    $limit: '2000',
  });
  return rows.map((r) => ({ ...r, loc: parseLocation(r.property_location) }));
}

// Pick the building: exact number first, then a same-side range with the smallest span.
function pickBuilding(rows, addr) {
  if (addr.suffix && rows.some((r) => r.loc.suffix === addr.suffix)) {
    rows = rows.filter((r) => r.loc.suffix === addr.suffix);
  }
  const exact = rows.filter((r) => r.loc.lo === addr.number || r.loc.hi === addr.number);
  if (exact.length) return exact;
  const ranged = rows.filter(
    (r) => r.loc.hi && Math.min(r.loc.lo, r.loc.hi) <= addr.number &&
      Math.max(r.loc.lo, r.loc.hi) >= addr.number && r.loc.lo % 2 === addr.number % 2,
  );
  if (!ranged.length) return [];
  const span = (r) => Math.abs(r.loc.hi - r.loc.lo);
  const best = ranged.reduce((a, b) => (span(b) < span(a) ? b : a));
  const key = best.property_location.slice(0, 32);
  return ranged.filter((r) => r.property_location.slice(0, 32) === key);
}

const RES_CONDO = /condo|town house/i;
const NON_RES = /commercial|office|parking|industrial|store/i;

function summarize(rows) {
  const units = (r) => Math.round(parseFloat(r.number_of_units) || 0);
  const condoRows = rows.filter((r) => RES_CONDO.test(r.property_class_code_definition || '') && !NON_RES.test(r.property_class_code_definition));
  const isCondo = condoRows.length > 0 && condoRows.length * 2 >= rows.length;
  const years = rows.map((r) => parseInt(r.year_property_built, 10)).filter((y) => y > 1800 && y <= 2100);
  const primary = rows.reduce((a, b) => (units(b) > units(a) ? b : a));
  const parcels = [...new Set(rows.map((r) => r.parcel_number))].sort();
  return {
    parcels,
    parcel: isCondo ? parcels[0] : primary.parcel_number,
    matched_address: displayAddress(primary.loc),
    loc: primary.loc,
    year_built: years.length ? Math.min(...years) : null,
    units: isCondo
      ? condoRows.reduce((sum, r) => sum + Math.max(1, units(r)), 0)
      : rows.reduce((sum, r) => sum + units(r), 0),
    isCondo,
    use: isCondo ? 'Condominium' : primary.use_definition || null,
    zoning: primary.zoning_code || null,
  };
}

// ---------- Rules (SF Rent Ordinance, simplified) ----------

export function rentControl({ year_built: year, units, isCondo, use }) {
  if (!year) return { status: 'unknown', reason: 'Year built is not on record.' };
  if (year >= 1979) {
    return {
      status: 'not_covered',
      reason: `Built in ${year}, after June 13, 1979: new construction is exempt from SF rent-increase limits; just-cause eviction rules may still apply.`,
    };
  }
  if (isCondo) {
    return {
      status: 'exempt_increases',
      reason: `Condominium unit (built ${year}): exempt from rent-increase limits under Costa-Hawkins; eviction protections may still apply.`,
    };
  }
  if (units === 1) {
    return {
      status: 'exempt_increases',
      reason: `Single-family home (built ${year}): exempt from rent-increase limits under Costa-Hawkins; eviction protections may still apply.`,
    };
  }
  if (units >= 2) {
    return {
      status: 'likely',
      reason: `Built in ${year}, before June 13, 1979, with ${units} units: covered by the SF Rent Ordinance (rent-increase limits and just-cause eviction).`,
    };
  }
  return { status: 'unknown', reason: `No residential units on record (use: ${use || 'unknown'}).` };
}

const STATUS_LABEL = {
  likely: 'likely',
  not_covered: 'no (post-1979 construction)',
  exempt_increases: 'no rent-increase limits (Costa-Hawkins), eviction protections may apply',
  unknown: 'unknown',
};

// ---------- DBI complaints ----------

async function getComplaints(building, number) {
  // Condo complaints are often filed on the original lot, so match the block + street number too.
  const list = (xs) => [...new Set(xs)].map(q).join(',');
  const blocks = list(building.parcels.map((p) => p.slice(0, 4)));
  const numbers = list([number, building.loc.lo, building.loc.hi].filter(Boolean).map(String));
  const where = `block in (${blocks}) AND (parcel_number in (${list(building.parcels.slice(0, 300))}) OR street_number in (${numbers}))`;
  const [byStatus, latest] = await Promise.all([
    soql(COMPLAINTS, { $select: 'status,count(*) AS n', $where: where, $group: 'status' }),
    soql(COMPLAINTS, {
      $select: 'date_filed,status,complaint_description',
      $where: where,
      $order: 'date_filed DESC',
      $limit: '3',
    }),
  ]);
  const count = (pred) => byStatus.filter(pred).reduce((s, r) => s + Number(r.n), 0);
  return {
    total: count(() => true),
    open: count((r) => r.status === 'Active'),
    latest: latest.map((c) => ({
      date: (c.date_filed || '').slice(0, 10),
      status: c.status || null,
      description: truncate((c.complaint_description || '').replace(/\s+/g, ' ').trim(), 140),
    })),
  };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// ---------- Public API ----------

export async function checkAddress(address) {
  const address_query = String(address ?? '').trim();
  const notFound = { address_query, found: false, verdict: 'Address not found in SF property records.' };
  const addr = parseAddress(address_query);
  if (!addr) return notFound;

  let year, rows;
  try {
    year = await latestYear();
    rows = pickBuilding(await findRows(addr, year), addr);
  } catch (err) {
    return {
      address_query,
      found: false,
      error: `City property data unavailable: ${err.message}`,
      verdict: 'Lookup failed: SF property records are temporarily unavailable. Try again.',
    };
  }
  if (!rows.length) return notFound;

  const b = summarize(rows);
  const rent_control = rentControl(b);

  let complaints;
  try {
    complaints = await getComplaints(b, addr.number);
  } catch (err) {
    complaints = { total: null, open: null, latest: [], error: `DBI complaints unavailable: ${err.message}` };
  }

  const openText = complaints.open === null ? 'unavailable' : complaints.open === 0 ? 'none' : String(complaints.open);
  return {
    address_query,
    found: true,
    matched_address: b.matched_address,
    parcel: b.parcel,
    year_built: b.year_built,
    units: b.units,
    use: b.use,
    zoning: b.zoning,
    rent_control,
    complaints,
    verdict: `Rent-controlled: ${STATUS_LABEL[rent_control.status]}. Units: ${b.units}. Open complaints: ${openText}.`,
    sources: [`SF Assessor secured roll ${year} (${ASSESSOR})`, `DBI complaints (${COMPLAINTS})`],
    disclaimer: DISCLAIMER,
  };
}
