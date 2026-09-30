// Tests for src/data.js: offline helpers + live data.sf.gov lookups.  Run: node scripts/test-data.js
// Set VERBOSE=1 to print full JSON results.
import { checkAddress, parseUnit, unitCheck, redact } from '../src/data.js';

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? `  (${detail})` : ''}`);
}
const cats = (r) => (r.red_flags || []).map((f) => f.category);

// ---------- Offline: unit parsing, unit check, redaction ----------
console.log('\nOffline helpers');
check('parseUnit "Apt 5"', parseUnit('372 7th Ave Apt 5')?.unit === '5');
check('parseUnit "#5"', parseUnit('372 7th Ave #5')?.label === '#5');
check('parseUnit "Unit 5"', parseUnit('372 7th Ave, Unit 5, San Francisco')?.label === 'Unit 5');
check('parseUnit "Apt 107"', parseUnit('1665 Chestnut St Apt 107')?.unit === '107');
check('parseUnit "#2B"', parseUnit('1824 Anza St #2B')?.unit === '2B');
check('parseUnit ignores "Aptos Ave"', parseUnit('123 Aptos Ave') === null);
check('parseUnit none', parseUnit('1824 Anza St') === null);
check('unitCheck Apt 5 of 3 -> flag', unitCheck({ unit: '5', label: 'Apt 5' }, 3).flag === true);
check('unitCheck Apt 3 of 3 -> ok', unitCheck({ unit: '3', label: 'Apt 3' }, 3).flag === false);
check('unitCheck Apt 301 of 3 -> ok (floor-based)', unitCheck({ unit: '301', label: 'Apt 301' }, 3).flag === false);
check('unitCheck Apt 107 of 24 -> not checked', unitCheck({ unit: '107', label: 'Apt 107' }, 24).flag === false);
check('unitCheck #2B -> not checked', unitCheck({ unit: '2B', label: '#2B' }, 3).flag === false);
check('unitCheck note wording', unitCheck({ unit: '5', label: 'Apt 5' }, 3).note ===
  'Possible unwarranted unit — listing says Apt 5, city records show 3 legal units.');
const red = redact('Call 415-555-1234, (415) 555 1234 or +1 415.555.1234, mail jo.doe@example.com (311 sr 101000872662)');
check('redact phones + email', !/555|example/.test(red) && red.includes('[phone]') && red.includes('[email]'), red);
check('redact keeps 311 SR numbers', red.includes('101000872662'), red);

// ---------- Live: data.sf.gov ----------
const cases = [
  ['1423 Kearny St', (r) => {
    check('status likely', r.rent_control?.status === 'likely');
  }], // 6-unit 1906 building, stored as range 1413-1423
  ['1855 Kearny St, San Francisco, CA 94133', (r) => {
    check('status not_covered', r.rent_control?.status === 'not_covered');
    check('AB 1482 mentioned (built 1983, 136 units)', /AB 1482/.test(r.rent_control?.reason));
  }],
  ['4436 irving street', (r) => check('status exempt_increases (single-family)', r.rent_control?.status === 'exempt_increases')],
  ['999 Green St', (r) => check('status exempt_increases (condo)', r.rent_control?.status === 'exempt_increases')],
  ['123 Nowhere Imaginary Blvd', (r) => check('found: false', r.found === false)],

  // Demo 1: looks perfect, but mold + dead elevator in the complaint history.
  ['1665 Chestnut St', (r) => {
    check('status likely', r.rent_control?.status === 'likely');
    check('24 units, built 1950', r.units === 24 && r.year_built === 1950, `${r.units} / ${r.year_built}`);
    for (const c of ['mold', 'elevator', 'heat_water']) check(`red flag ${c}`, cats(r).includes(c), cats(r).join(','));
    check('full history scanned (>= 15 complaints)', r.complaints?.total >= 15, r.complaints?.total);
    check('routine inspections not counted as problems', r.complaints?.problems < r.complaints?.total);
    check('soft-story retrofit complete', r.soft_story?.retrofit_complete === true, JSON.stringify(r.soft_story));
    check('verdict mentions mold + elevator', /mold/.test(r.verdict) && /elevator/.test(r.verdict), r.verdict);
    check('examples max 2 and <= 160 chars', r.red_flags.every((f) => f.examples.length <= 2 && f.examples.every((e) => e.description.length <= 160)));
  }],
  ['1665 Chestnut St Apt 107', (r) => check('Apt 107 in a 24-unit building not flagged', r.unit_check?.flag === false, r.unit_check?.note)],

  // Demo 2: listing says Apt 5, city says 3 legal units.
  ['372 7th Ave Apt 5', (r) => {
    check('status not_covered (built 1993)', r.rent_control?.status === 'not_covered');
    check('AB 1482 mentioned', /AB 1482/.test(r.rent_control?.reason));
    check('unit flag: Apt 5 vs 3 legal units', r.unit_check?.flag === true && r.unit_check?.legal_units === 3, JSON.stringify(r.unit_check));
    for (const c of ['illegal_units', 'unpermitted_work']) check(`red flag ${c}`, cats(r).includes(c), cats(r).join(','));
    check('verdict leads with unwarranted unit', /^⚠ Possible unwarranted unit/.test(r.verdict), r.verdict);
  }],

  // Demo 3: clean pass (green light).
  ['1824 Anza St', (r) => {
    check('status likely', r.rent_control?.status === 'likely');
    check('no red flags', r.red_flags?.length === 0, cats(r).join(','));
    check('routine-only history -> 0 problems', r.complaints?.problems === 0 && r.complaints?.total >= 1);
    check('unit_check not flagged', r.unit_check?.flag === false);
    check('verdict is a green light', /^✅/.test(r.verdict), r.verdict);
  }],
];

for (const [address, assert] of cases) {
  const t0 = Date.now();
  const r = await checkAddress(address);
  const ms = Date.now() - t0;
  console.log(`\n${address}  (${ms} ms${ms > 4000 ? ', WARN: over 4 s' : ''})`);
  console.log(`  verdict: ${r.verdict}`);
  if (process.env.VERBOSE) console.log(JSON.stringify(r, null, 2));
  try {
    assert(r);
  } catch (err) {
    check('assertions ran', false, err.message);
  }
}
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
