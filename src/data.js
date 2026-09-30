// San Francisco rent-control lookup from open city data (data.sf.gov, Socrata).
// No dependencies: uses Node's built-in fetch.

const BASE = 'https://data.sf.gov/resource';
const ASSESSOR = 'wv5m-vpq2'; // Assessor secured roll
const COMPLAINTS = 'gm2e-bten'; // DBI complaints
const SOFT_STORY = 'beah-shgi'; // Mandatory Soft-Story Retrofit Program properties
const TIMEOUT_MS = 8000; // Assessor lookup (required)
const EXTRA_TIMEOUT_MS = 3500; // complaints / soft-story (optional): keep the lookup under ~4 s
const FALLBACK_YEAR = '2025';
const DISCLAIMER = 'Informational, not legal advice.';

// ---------- HTTP ----------

async function soql(dataset, params, timeout = TIMEOUT_MS) {
  const url = `${BASE}/${dataset}.json?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
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
    $select: 'property_location,parcel_number,year_property_built,number_of_units,property_area,use_definition,property_class_code_definition,zoning_code',
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
    building_sqft: Math.round(rows.reduce((sum, r) => sum + (parseFloat(r.property_area) || 0), 0)) || null,
  };
}

// "…listed as 700 sq ft" -> 700
export function parseSqft(input) {
  const m = String(input || '').match(/\b(\d{3,4}|\d,\d{3})\s*(?:sq\.?\s*ft|sqft|square\s*feet|sf)\b/i);
  return m ? Number(m[1].replace(',', '')) : null;
}

// The Assessor's building area includes hallways and stairs, so area ÷ units is an upper bound on a typical unit.
export function sizeCheck(claimed, buildingSqft, units, isCondo) {
  const per_unit = buildingSqft && units && !isCondo ? Math.round(buildingSqft / units) : null;
  const base = { claimed_sqft: claimed, building_sqft: buildingSqft, avg_unit_sqft_incl_common: per_unit, flag: false };
  if (!claimed || !per_unit) return { ...base, note: claimed ? 'Not enough city data to check the size.' : 'No listing size given.' };
  const lo = Math.round((per_unit * 0.85) / 10) * 10;
  const hi = Math.round((per_unit * 0.93) / 10) * 10;
  const note = `Listing says ${claimed} sq ft. City records: ${buildingSqft.toLocaleString('en-US')} sq ft building ÷ ${units} units ≈ ${per_unit} sq ft each including hallways, so a typical unit is about ${lo}–${hi} sq ft.`;
  return { ...base, flag: claimed > per_unit, note };
}

// "372 7th Ave Apt 5" -> { label: "Apt 5", unit: "5" }; "#2B" -> { label: "#2B", unit: "2B" }
export function parseUnit(input) {
  const m = String(input || '').match(
    /(?:^|[\s,])(#|(?:APT|APARTMENT|UNIT|STE|SUITE)\b\.?\s*#?)\s*([A-Z]?\d+[A-Z]?|[A-Z])(?![\w-])/i,
  );
  if (!m) return null;
  const unit = m[2].toUpperCase();
  const kind = m[1].replace(/[.#\s]/g, '').toUpperCase();
  const label = kind ? `${{ APARTMENT: 'Apt', STE: 'Suite' }[kind] || titleCase(kind)} ${unit}` : `#${unit}`;
  return { unit, label };
}

// ---------- Rules (SF Rent Ordinance + CA AB 1482, simplified) ----------

const AB1482_TEXT = 'California AB 1482 statewide cap likely applies (5% + CPI, max 10%/yr)';

export function rentControl({ year_built: year, units, isCondo, use }, now = new Date()) {
  if (!year) return { status: 'unknown', reason: 'Year built is not on record.' };
  if (year >= 1979) {
    // AB 1482 exempts buildings with a certificate of occupancy in the last 15 years (rolling) and single-family homes.
    const ab1482 = units >= 2 && !isCondo && now.getFullYear() - year > 15;
    return {
      status: 'not_covered',
      reason: ab1482
        ? `Built in ${year}, after June 13, 1979: not under SF Rent Ordinance, but ${AB1482_TEXT}; just-cause eviction rules may also apply.`
        : `Built in ${year}, after June 13, 1979: new construction is exempt from SF rent-increase limits; just-cause eviction rules may still apply.`,
      ...(ab1482 && { state_cap: 'AB 1482 likely' }),
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
      reason: `Built in ${year}, before June 13, 1979, with ${units} units: likely covered by the SF Rent Ordinance (rent-increase limits and just-cause eviction).`,
    };
  }
  return { status: 'unknown', reason: `No residential units on record (use: ${use || 'unknown'}).` };
}

function rentLabel(rc, year) {
  if (rc.status === 'likely') return 'Rent-controlled: likely.';
  if (rc.status === 'not_covered') {
    return `Rent-controlled: no (built ${year}, after 1979)${rc.state_cap ? ', but state AB 1482 cap likely applies' : ''}.`;
  }
  if (rc.status === 'exempt_increases') return 'Rent-controlled: no rent-increase limits (Costa-Hawkins); eviction protections may apply.';
  return 'Rent-controlled: unknown.';
}

// Listing says "Apt 5" but the city records 3 legal units -> possible unwarranted unit.
// Conservative: only small buildings (<= 10 units), only plain numbers; 3-digit numbers (107, 201) are
// usually floor + unit, so only their last two digits are compared.
export function unitCheck(claimed, legalUnits, isCondo) {
  const base = { claimed_unit: claimed?.unit ?? null, legal_units: legalUnits ?? null, flag: false };
  if (!claimed) return { ...base, note: 'No unit in the query.' };
  const { unit, label } = claimed;
  if (!legalUnits) return { ...base, note: `${label}: no residential unit count on record, not checked.` };
  if (isCondo) return { ...base, note: `${label}: condominium parcels, not checked.` };
  if (!/^\d+$/.test(unit)) return { ...base, note: `${label}: not a plain number, not checked.` };
  if (legalUnits > 10) {
    return { ...base, note: `${label}: ${legalUnits}-unit building, unit numbers are often floor-based, not checked.` };
  }
  const n = parseInt(unit, 10);
  const idx = n >= 100 ? n % 100 : n;
  if (idx > legalUnits) {
    return {
      ...base,
      flag: true,
      note: `Possible unwarranted unit — listing says ${label}, city records show ${legalUnits} legal unit${legalUnits === 1 ? '' : 's'}.`,
    };
  }
  return { ...base, note: `${label} is consistent with ${legalUnits} legal unit${legalUnits === 1 ? '' : 's'}.` };
}

// ---------- DBI complaints ----------

// Red-flag categories, in severity order (health and safety first). Matched against cleaned, lower-cased complaint text.
const RED_FLAGS = [
  ['illegal_units', 'possible illegal units',
    /\billegal (units?|dwellings?|apartments?|conversion|occupancy)\b|change of use|\bunwarranted\b|\bin-?law\b|\bcommunal\b|\b\d+ rooms\b|\bzoning\b/],
  ['mold', 'mold', /\bmou?ldy?\b|\bmildew\b/],
  ['water_sewage', 'sewage / flooding / leaks',
    /\bsewer\b|\bsewage\b|\bblack water\b|\bflood(s|ed|ing)?\b|\bleak(s|ed|ing|y)?\b|\bwater damage\b|\bbacked up\b|\boverflow(s|ing)?\b/],
  ['structural', 'structural damage',
    /\bcollaps(e|ed|es|ing)\b|\bspalling\b|\bstructural\b|\bcracks? in (the )?(wall|foundation|ceiling)s?\b|\bsagging\b|\bdry ?rot\b|\bceiling (fell|falling)\b/],
  ['elevator', 'elevator outages', /\belevators?\b|\blift\b/],
  ['heat_water', 'heating / hot water', /\bno heat\b|\bheat(ing|er|ers)?\b|\bhot water\b|\btemperatures?\b|\bcold\b|\btoo hot\b/],
  ['electrical', 'electrical hazards', /\bexposed wir(e|es|ing)\b|\belectrical\b|\bwiring\b|\boutlets?\b|\bsparks?\b|\bno power\b|\bmeters?\b/],
  ['safety', 'fire / safety hazards', /\bfire\b|\bsmoke detectors?\b|\bexits?\b|\bdangerous\b|\bhazard(s|ous)?\b|\bcarbon monoxide\b|\bgas leak\b/],
  ['pests', 'pests', /\b(rodents?|rats?|mice|mouse|roach(es)?|cockroach(es)?|bed ?bugs?|vermin|infestation)\b/],
  ['security', 'locks / security', /\b(door|gate)s?\b[^.;]{0,40}\block(s|ed|ing)?\b|\bdoes(n'?t| not)( always)? lock\b|\bbroken locks?\b|\bintercom\b/],
  ['accessibility', 'accessibility', /\bdisabled acc(ess)?\b|\bwheelchair\b|\bada (access|compliance|ramp)\b/],
  ['unpermitted_work', 'unpermitted work',
    /\bw(ithout|\/o)( a| any)? permits?\b|\bno permits?\b|\bunpermitted\b|\bnot permitted\b|\billegal (retaining wall|construction|addition|work)\b/],
  ['construction', 'construction disruption',
    /\bconstruction\b|\bnois(e|y)\b|\bjackhammer(s|ing)?\b|\bdemolition\b|\b[4-7] ?(am|a\.m\.)|\b(9|10|11) ?(pm|p\.m\.)/],
];
// Negated phrases that would otherwise match ("free of any visible hazards").
const NEGATIONS = /\b(free of|no|without)( any)?( visible| obvious)? hazards?\b/g;

const PHONE = /(?<![\w\d])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

export function redact(s) {
  return String(s || '').replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

// 311 web-form complaints start with "Date last observed: ...; building type: residence/dwelling <problem>; ...".
// Keep only the problem part and the free-text "additional information".
function cleanDescription(raw) {
  let s = redact(raw).replace(/\s+/g, ' ').trim();
  const form = s.match(/^date last observed:.*?building type:\s*(?:residence\/dwelling|commercial\/business|commercial|both|other|unknown)?\s*(.*)$/i);
  if (form) {
    s = form[1].replace(/\s*;\s*;\s*/g, '; ').replace(/;?\s*additional information:\s*/i, ' — ').replace(/[;\s]+$/, '');
  }
  return s;
}

const isRoutine = (desc, novType) => /^routine\b/i.test(desc) || (!desc && /routine/i.test(novType || ''));

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// A ~160-char excerpt that shows the matched keyword.
function excerpt(s, re, n = 160) {
  const i = s.toLowerCase().search(re);
  if (i < n - 40) return truncate(s, n);
  return truncate('…' + s.slice(Math.max(0, i - 40)).trimStart(), n);
}

function yearsText(dates) {
  const ys = [...new Set(dates.map((d) => Number(d.slice(0, 4))).filter(Boolean))].sort();
  if (ys.length <= 2) return ys.join(', ');
  return `${ys[0]}–${ys.at(-1)}`;
}

export function redFlags(complaints) {
  const flags = [];
  for (const [category, label, re] of RED_FLAGS) {
    const hits = complaints.filter((c) => !c.routine && re.test(c.text.toLowerCase().replace(NEGATIONS, '')));
    if (!hits.length) continue;
    // Examples: most recent first, preferring plain-language complaints over 311 form dumps.
    const examples = [...hits]
      .sort((a, b) => a.form - b.form || b.date.localeCompare(a.date))
      .slice(0, 2)
      .map((c) => ({ date: c.date, description: excerpt(c.text, re) }));
    const flag = {
      category,
      label,
      count: hits.length,
      latest_date: hits.map((c) => c.date).sort().at(-1) || null,
      years: yearsText(hits.map((c) => c.date)),
      examples,
    };
    // Which complaints raised it (not serialized): lets the verdict skip a flag that only repeats one already shown.
    Object.defineProperty(flag, 'hits', { value: new Set(hits.map((c) => c.date + c.text)) });
    flags.push(flag);
  }
  // Illegal units lead, then anything from the last two years (most recent first), then the rest by severity.
  const recent = (f) => f.latest_date && Date.now() - new Date(f.latest_date) < 730 * 24 * 3600 * 1000;
  return flags
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.category === 'illegal_units') - (a.f.category === 'illegal_units')
      || recent(b.f) - recent(a.f)
      || (recent(a.f) ? String(b.f.latest_date).localeCompare(String(a.f.latest_date)) : a.i - b.i))
    .map(({ f }) => f);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "elevator outages (2008–2026, latest Sep 2026)" when the latest complaint is from the past year.
function flagText(f, now = new Date()) {
  const d = new Date(f.latest_date);
  const recent = f.latest_date && now - d < 365 * 24 * 3600 * 1000;
  const latest = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${f.label} (${recent && f.years !== String(d.getUTCFullYear()) ? `${f.years}, latest ${latest}` : recent ? latest : f.years})`;
}

// Up to three flags for the verdict, skipping any raised only by complaints an earlier flag already covers.
function verdictFlags(flags, n = 3) {
  const shown = [];
  const seen = new Set();
  for (const f of flags) {
    if (shown.length === n) break;
    if (f.hits && [...f.hits].every((h) => seen.has(h))) continue;
    shown.push(f);
    f.hits?.forEach((h) => seen.add(h));
  }
  return shown;
}

async function getComplaints(building, number) {
  // Condo complaints are often filed on the original lot, so match the block + street number too.
  const list = (xs) => [...new Set(xs)].map(q).join(',');
  const blocks = list(building.parcels.map((p) => p.slice(0, 4)));
  const numbers = list([number, building.loc.lo, building.loc.hi].filter(Boolean).map(String));
  const where = `block in (${blocks}) AND (parcel_number in (${list(building.parcels.slice(0, 300))}) OR street_number in (${numbers}))`;
  const rows = await soql(COMPLAINTS, {
    $select: 'date_filed,status,nov_type,complaint_description',
    $where: where,
    $order: 'date_filed DESC',
    $limit: '5000',
  }, EXTRA_TIMEOUT_MS);
  const all = rows.map((c) => {
    const raw = (c.complaint_description || '').trim();
    const text = cleanDescription(raw);
    return {
      date: (c.date_filed || '').slice(0, 10),
      status: c.status || null,
      text,
      form: /^date last observed:/i.test(raw) ? 1 : 0,
      routine: isRoutine(text, c.nov_type),
    };
  });
  return {
    total: all.length,
    problems: all.filter((c) => !c.routine).length,
    open: all.filter((c) => c.status === 'Active').length,
    open_since: all.filter((c) => c.status === 'Active').map((c) => c.date).filter(Boolean).sort()[0] || null,
    open_items: all.filter((c) => c.status === 'Active').slice(0, 3).map((c) => ({ date: c.date, description: truncate(c.text, 160) })),
    latest: all.slice(0, 3).map((c) => ({ date: c.date, status: c.status, description: truncate(c.text, 140) })),
    red_flags: redFlags(all),
  };
}

// ---------- Soft-story retrofit program ----------

async function getSoftStory(building) {
  // The dataset sometimes drops the lot's leading zeros ("161820" for block 1618, lot 020).
  const ids = building.parcels.slice(0, 100).flatMap((p) => [p, p.slice(0, 4) + p.slice(4).replace(/^0+/, '')]);
  const rows = await soql(SOFT_STORY, {
    $select: 'parcel_number,status,tier',
    $where: `parcel_number in (${[...new Set(ids)].map(q).join(',')})`,
    $limit: '10',
  }, EXTRA_TIMEOUT_MS);
  if (!rows.length) return { on_list: false, status: null, retrofit_complete: null };
  const r = rows.find((x) => /complete/i.test(x.status || '')) || rows[0];
  const status = r.status || null;
  return {
    on_list: true,
    status,
    retrofit_complete: /work complete/i.test(status || ''),
    tier: r.tier || null,
  };
}

function softStoryText(ss) {
  if (!ss?.on_list) return '';
  if (ss.retrofit_complete) return ' Soft-story retrofit: complete.';
  if (/non-compliant/i.test(ss.status || '')) return ' ⚠ Soft-story retrofit: NOT done (non-compliant).';
  return ` Soft-story retrofit: ${ss.status || 'status unknown'}.`;
}

// ---------- Public API ----------

export async function checkAddress(address, { sqft } = {}) {
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
  const unit_check = unitCheck(parseUnit(address_query), b.units, b.isCondo);
  const size_check = sizeCheck(Number(sqft) || parseSqft(address_query), b.building_sqft, b.units, b.isCondo);

  const [complaintsRes, softRes] = await Promise.allSettled([
    // One retry: data.sf.gov occasionally stalls on a cold query, and a missing complaint history hides the red flags.
    getComplaints(b, addr.number).catch(() => getComplaints(b, addr.number)),
    getSoftStory(b),
  ]);
  const { red_flags = [], ...complaints } = complaintsRes.status === 'fulfilled'
    ? complaintsRes.value
    : { total: null, problems: null, open: null, latest: [], error: `DBI complaints unavailable: ${complaintsRes.reason?.message}` };
  const soft_story = softRes.status === 'fulfilled' ? softRes.value : null;

  // Verdict: short and demo-ready.
  const parts = [];
  if (unit_check.flag) parts.push(`⚠ Possible unwarranted unit: listing says ${parseUnit(address_query).label}, city shows ${b.units} legal units.`);
  if (size_check.flag) parts.push(`⚠ Size looks inflated: listing says ${size_check.claimed_sqft} sq ft, city records suggest under ${size_check.avg_unit_sqft_incl_common}.`);
  const clean = !unit_check.flag && !size_check.flag && complaints.problems === 0 && !/⚠/.test(softStoryText(soft_story));
  parts.push(`${clean ? '✅ ' : ''}${rentLabel(rent_control, b.year_built)} ${b.units} unit${b.units === 1 ? '' : 's'}.`);
  if (red_flags.length) {
    parts.push(`⚠ Red flags: ${verdictFlags(red_flags).map((f) => flagText(f)).join(', ')}.`);
  } else if (complaints.problems === 0) {
    parts.push('No problem complaints on record.');
  } else if (complaints.problems === null) {
    parts.push('Complaint history unavailable.');
  } else {
    parts.push(`${complaints.problems} complaint${complaints.problems === 1 ? '' : 's'} on record, no red flags.`);
  }
  if (complaints.open) {
    const since = complaints.open_since?.slice(0, 4);
    const old = since && new Date().getFullYear() - Number(since) >= 2;
    parts.push(old
      ? `⚠ ${complaints.open} complaint${complaints.open === 1 ? '' : 's'} open since ${since}, never closed.`
      : `Open complaints: ${complaints.open}.`);
  }
  const verdict = parts.join(' ') + softStoryText(soft_story);

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
    unit_check,
    size_check,
    complaints,
    red_flags,
    soft_story,
    verdict,
    sources: [
      `SF Assessor secured roll ${year} (${ASSESSOR})`,
      `DBI complaints (${COMPLAINTS})`,
      `Soft-story retrofit program (${SOFT_STORY})`,
    ],
    disclaimer: DISCLAIMER,
  };
}
