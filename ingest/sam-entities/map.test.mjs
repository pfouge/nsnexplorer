// node:test suite for map.mjs against the synthetic fixture in the real V2 public column layout.
// Run: node --test ingest/sam-entities/map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLine, normalizeUrl, parseNaics, parseSba, parseBusinessTypes, isoDate, COLUMN_COUNT } from './map.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = 'SAM_PUBLIC_MONTHLY_V2_20261004.dat';
const lines = readFileSync(path.join(dir, 'fixtures', FILE), 'utf8').split('\n').filter((l) => l !== '');

test('fixture lines have the real column layout', () => {
  assert.equal(lines[1].split('|').length, COLUMN_COUNT);
  assert.equal(lines[1].split('|')[141], '!end');
  assert.equal(lines[1].split('|')[3], '1ABC2'); // layout column 4 = CAGE
  assert.equal(lines[1].split('|')[0], 'ABCDEFGH1234'); // layout column 1 = UEI
});

test('header and trailer lines are recognised and skipped', () => {
  assert.deepEqual(mapLine(lines[0], FILE), { skip: 'header' });
  assert.deepEqual(mapLine(lines.at(-1), FILE), { skip: 'trailer' });
});

test('full record: DBA, mailing address, URL, business types, NAICS, PSC, SBA and POCs', () => {
  const { row } = mapLine(lines[1], FILE);
  assert.equal(row.cage, '1ABC2');
  assert.equal(row.uei, 'ABCDEFGH1234');
  assert.equal(row.legal_name, 'ACME FASTENERS INCORPORATED');
  assert.equal(row.dba_name, 'ACME FASTENERS');
  assert.equal(row.entity_url, 'https://www.acmefasteners.com/Home?x=1');
  assert.deepEqual([row.phys_line1, row.phys_line2, row.phys_city, row.phys_state, row.phys_zip, row.phys_zip4, row.phys_country],
    ['100 Industrial Pkwy', 'Building 4', 'Dayton', 'OH', '45402', '1234', 'USA']);
  assert.deepEqual([row.mail_line1, row.mail_line2, row.mail_city, row.mail_state, row.mail_zip, row.mail_zip4, row.mail_country],
    ['PO Box 77', null, 'Dayton', 'OH', '45401', '0077', 'USA']);
  assert.equal(row.registration_status, 'Active');
  assert.equal(row.registration_date, '2012-03-01');
  assert.equal(row.expiration_date, '2027-10-04');
  assert.equal(row.last_update_date, '2026-09-15');
  assert.equal(row.activation_date, '2026-10-04');
  assert.equal(row.entity_start_date, '1987-06-15');
  assert.equal(row.entity_structure, 'Corporate Entity (Not Tax Exempt)');
  assert.equal(row.state_of_incorporation, 'OH');
  // known codes get labels, unknown code ZZ stays as the code
  assert.deepEqual(row.business_types, ['For Profit Organization', 'Manufacturer of Goods', 'Self Certified Small Disadvantaged Business', 'ZZ']);
  assert.equal(row.primary_naics, '332722');
  assert.deepEqual(row.naics, [
    { code: '332722', small: true },
    { code: '332721', small: false },
    { code: '423840', small: null }, // E = see exception string
  ]);
  assert.deepEqual(row.psc, ['5310', '5305']);
  assert.deepEqual(row.sba_certifications, [
    { label: '8(a)', entry: null, exit: '2030-01-01' },
    { label: 'HUBZone', entry: null, exit: '2029-02-02' },
  ]);
  // POCs: role, name, title only (street addresses in the file are never read)
  assert.deepEqual(row.pocs, [
    { role: 'Government Business POC', name: 'Jane Q Doe', title: 'President' },
    { role: 'Alternate Government Business POC', name: 'John Roe', title: 'Sales Manager' },
    { role: 'Electronic Business POC', name: 'Pat Poe', title: 'Contracts' },
  ]);
  assert.equal(JSON.stringify(row.pocs).includes('Pkwy'), false);
  assert.equal(row.source_file, FILE);
});

test('minimal record: sparse fields come back null / empty, expired status, bad URL rejected', () => {
  const { row } = mapLine(lines[2], FILE);
  assert.equal(row.cage, '3DEF4');
  assert.equal(row.registration_status, 'Expired');
  assert.equal(row.dba_name, null);
  assert.equal(row.entity_url, null); // "no website listed" has no dotted host
  assert.equal(row.mail_line1, null);
  assert.equal(row.entity_structure, 'Partnership or Limited Liability Partnership');
  assert.deepEqual(row.business_types, []);
  assert.deepEqual(row.naics, []);
  assert.deepEqual(row.psc, []);
  assert.deepEqual(row.sba_certifications, []);
  assert.deepEqual(row.pocs, []);
  assert.equal(row.primary_naics, null);
  assert.equal(row.state_of_incorporation, null);
});

test('malformed line is skipped, not thrown', () => {
  assert.deepEqual(mapLine(lines[3], FILE), { skip: 'malformed' });
  // right column count but no !end marker
  const cols = lines[1].split('|');
  cols[141] = 'xxxx';
  assert.deepEqual(mapLine(cols.join('|'), FILE), { skip: 'malformed' });
});

test('records without a usable CAGE or flagged no-public-display are skipped', () => {
  const cols = lines[1].split('|');
  const noCage = cols.slice(); noCage[3] = '';
  assert.deepEqual(mapLine(noCage.join('|'), FILE), { skip: 'no_cage' });
  const npdy = cols.slice(); npdy[118] = 'NPDY';
  assert.deepEqual(mapLine(npdy.join('|'), FILE), { skip: 'no_public_display' });
});

test('POC entries carry role, name and title only; the row has exactly the supplier_sam columns', () => {
  const cols = lines[1].split('|');
  cols[46 + 4] = '555-555-0100'; // a street column: must not surface anywhere
  const { row } = mapLine(cols.join('|'), FILE);
  assert.equal(JSON.stringify(row.pocs).includes('555'), false);
  for (const p of row.pocs) assert.deepEqual(Object.keys(p), ['role', 'name', 'title']);
  const migration = readFileSync(path.join(dir, '../../db/migrations/0011_supplier_profiles.sql'), 'utf8');
  const ddl = /CREATE TABLE IF NOT EXISTS pub\.supplier_sam \(([\s\S]*?)\n\);/.exec(migration)[1];
  const cols2 = ddl.split('\n').map((l) => l.replace(/--.*/, '')).join(' ').split(/,(?![^(]*\))/).flatMap((c) => {
    const t = c.trim();
    return t.startsWith('PRIMARY') ? [] : [t.split(/\s+/)[0]];
  });
  const mapped = Object.keys(row).sort();
  const table = cols2.filter((c) => c && c !== 'synced_at').sort();
  // phys_*/mail_* columns are declared several per line; the flattening above keeps the first word of each comma part
  assert.deepEqual(mapped, table);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('www.Example.COM'), 'https://www.example.com/');
  assert.equal(normalizeUrl('  HTTP://Example.com/About Us '), 'http://example.com/About');
  assert.equal(normalizeUrl('https://example.com:8443/x#frag'), 'https://example.com:8443/x');
  assert.equal(normalizeUrl('ftp://example.com'), null);
  assert.equal(normalizeUrl('mailto:a@example.com'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('N/A'), null);
  assert.equal(normalizeUrl('localhost'), null);
  assert.equal(normalizeUrl('https://user:pw@example.com/'), null);
  assert.equal(normalizeUrl(''), null);
});

test('small parsers', () => {
  assert.equal(isoDate('20240230'), null);
  assert.equal(isoDate('20240229'), '2024-02-29');
  assert.deepEqual(parseNaics('~237990N~541340Y~'), [{ code: '237990', small: false }, { code: '541340', small: true }]);
  assert.deepEqual(parseNaics('112130 ~541330Y'), [{ code: '112130', small: null }, { code: '541330', small: true }]);
  assert.deepEqual(parseSba('~A620210101~XX20210102~'), [
    { label: '8(a)', entry: null, exit: '2021-01-01' },
    { label: 'HUBZone', entry: null, exit: '2021-01-02' },
  ]);
  assert.deepEqual(parseSba('A62020010120250101'), [{ label: '8(a)', entry: '2020-01-01', exit: '2025-01-01' }]);
  assert.deepEqual(parseBusinessTypes(''), []);
});
