#!/usr/bin/env node
// Writes fixtures/SAM_PUBLIC_MONTHLY_V2_20261004.dat: a synthetic extract in the real PUBLIC V2
// column layout (142 pipe-delimited columns, "!end" last). Positions below are the 1-based
// column numbers from the GSA layout (v1.5), written out independently of map.mjs's COL table
// so the mapper test is a genuine cross-check. Re-generate with: node fixtures/make-fixture.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function rec(vals) {
  const f = Array(142).fill('');
  for (const [pos, v] of Object.entries(vals)) f[Number(pos) - 1] = v;
  f[141] = '!end';
  return f.join('|');
}
// Six POC blocks start at column 47, 11 columns each: first, MI, last, title, st1, st2, city, zip, zip4, country, state.
const poc = (n, first, mi, last, title, street) => {
  const b = 47 + n * 11;
  return { [b]: first, [b + 1]: mi, [b + 2]: last, [b + 3]: title, [b + 4]: street, [b + 6]: 'Dayton', [b + 7]: '45402', [b + 9]: 'USA', [b + 10]: 'OH' };
};

const full = rec({
  1: 'ABCDEFGH1234', 2: '', 3: '0000', 4: '1ABC2', 5: '', 6: 'A', 7: 'Z2',
  8: '20120301', 9: '20271004', 10: '20260915', 11: '20261004',
  12: 'ACME FASTENERS INCORPORATED', 13: 'ACME FASTENERS',
  16: '100 Industrial Pkwy', 17: 'Building 4', 18: 'Dayton', 19: 'OH', 20: '45402', 21: '1234', 22: 'USA',
  25: '19870615', 26: '1231', 27: 'WWW.AcmeFasteners.com/Home?x=1  ',
  28: '2L', 29: 'OH', 30: 'USA',
  31: '4', 32: '2X~MF~27~ZZ',
  33: '332722', 34: '3', 35: '332722Y~332721N~423840E',
  36: '2', 37: '5310~5305',
  40: 'PO Box 77', 42: 'Dayton', 43: '45401', 44: '0077', 45: 'USA', 46: 'OH',
  ...poc(0, 'Jane', 'Q', 'Doe', 'President', '100 Industrial Pkwy'),
  ...poc(1, 'John', '', 'Roe', 'Sales Manager', '100 Industrial Pkwy'),
  ...poc(4, 'Pat', '', 'Poe', 'Contracts', '100 Industrial Pkwy'),
  117: '2', 118: 'A620300101~XX20290202',
  119: '', 
});
const minimal = rec({
  1: 'MINIMAL00001', 4: '3DEF4', 6: 'E',
  8: '20190101', 9: '20240101', 10: '20230101', 11: '20190102',
  12: 'BARE BONES MACHINE LLC',
  16: '9 Elm St', 18: 'Erie', 19: 'PA', 20: '16501', 22: 'USA',
  27: 'no website listed', 28: '2K',
});
const malformed = 'BOF-NOT|THIS|IS|A|BROKEN|LINE|WITH|TOO|FEW|COLUMNS|!end';
const notOurs = rec({
  1: 'NOTINDB00009', 4: '99999', 6: 'A', 8: '20200101', 9: '20270101', 10: '20260101', 11: '20200102',
  12: 'NOT A KNOWN SUPPLIER INC', 16: '1 Main St', 18: 'Austin', 19: 'TX', 20: '73301', 22: 'USA',
});

const text = [
  'BOF PUBLIC 20261004 20261004 0000000 0000001',
  full, minimal, malformed, notOurs,
  'EOF PUBLIC 20261004 20261004 0000000 0000001',
].join('\n') + '\n';
writeFileSync(path.join(dir, 'SAM_PUBLIC_MONTHLY_V2_20261004.dat'), text);
console.log('wrote fixture');
