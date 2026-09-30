// Smoke test for src/data.js against live data.sf.gov.  Run: node scripts/test-data.js
import { checkAddress } from '../src/data.js';

const cases = [
  ['1423 Kearny St', 'likely'], // 6-unit 1906 building, stored as range 1413-1423
  ['1855 Kearny St, San Francisco, CA 94133', 'not_covered'], // 136 units, built 1983
  ['4436 irving street', 'exempt_increases'], // single-family home, 1950
  ['999 Green St', 'exempt_increases'], // 1964 condo tower
  ['123 Nowhere Imaginary Blvd', null], // nonsense -> found: false
];

let failed = 0;
for (const [address, expected] of cases) {
  const t0 = Date.now();
  const r = await checkAddress(address);
  const got = r.found ? r.rent_control.status : null;
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} ${address}  (${Date.now() - t0} ms, expected ${expected}, got ${got})`);
  console.log(JSON.stringify(r, null, 2));
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
