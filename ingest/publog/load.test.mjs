// ingest/publog/load.test.mjs
// Pure-function tests for load.mjs. None of these touch Postgres: the CSV
// line splitter and the row-mapping helpers are plain functions with no DB
// access, which is exactly what lets them be tested without a database.

import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  splitCsvLine,
  normalizeCage,
  mapIdentificationRow,
  mapPartRow,
  mapCageRow,
  mapCharacteristicsRow,
  parseObsDate,
  normalizeAmc,
  normalizeAmsc,
  resolveMoeColumns,
  mapMoeRuleRow,
  isBetterMoeRow,
  collectMoeRule,
  PUBLOG_SOURCE_URL,
} from './load.mjs';

// ---------------------------------------------------------------------------
// splitCsvLine
// ---------------------------------------------------------------------------

test('splitCsvLine: plain unquoted fields', () => {
  assert.deepEqual(splitCsvLine('4935,000000012,foo'), ['4935', '000000012', 'foo']);
});

test('splitCsvLine: quoted fields', () => {
  assert.deepEqual(splitCsvLine('"4935","000000012","foo"'), ['4935', '000000012', 'foo']);
});

test('splitCsvLine: quoted field containing a comma', () => {
  assert.deepEqual(
    splitCsvLine('"00000","H","A","S0140A","ORDNANCE, CORPS","BATTLE CREEK"'),
    ['00000', 'H', 'A', 'S0140A', 'ORDNANCE, CORPS', 'BATTLE CREEK']
  );
});

test('splitCsvLine: doubled quotes unescape to a single quote', () => {
  assert.deepEqual(splitCsvLine('"foo","BOB\'S ""BIG"" GASKET",baz'), [
    'foo',
    'BOB\'S "BIG" GASKET',
    'baz',
  ]);
});

test('splitCsvLine: empty fields (leading, trailing, and consecutive commas)', () => {
  assert.deepEqual(splitCsvLine('"4935","",""'), ['4935', '', '']);
  assert.deepEqual(splitCsvLine(',,'), ['', '', '']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
});

test('splitCsvLine: real P_FLIS_NSN.CSV sample row', () => {
  const line = '"4935","000000012","","NO ITEM NAME AVAILABLE","","",""';
  assert.deepEqual(splitCsvLine(line), [
    '4935',
    '000000012',
    '',
    'NO ITEM NAME AVAILABLE',
    '',
    '',
    '',
  ]);
});

// ---------------------------------------------------------------------------
// normalizeCage
// ---------------------------------------------------------------------------

test('normalizeCage: uppercases and accepts 5-char alphanumeric', () => {
  assert.equal(normalizeCage('24039'), '24039');
  assert.equal(normalizeCage('1a2b3'), '1A2B3');
});

test('normalizeCage: rejects malformed CAGE codes', () => {
  assert.equal(normalizeCage(''), null);
  assert.equal(normalizeCage('1234'), null); // too short
  assert.equal(normalizeCage('123456'), null); // too long
  assert.equal(normalizeCage('1234-'), null); // bad char
  assert.equal(normalizeCage(undefined), null);
});

// ---------------------------------------------------------------------------
// mapIdentificationRow
// ---------------------------------------------------------------------------

test('mapIdentificationRow: updates a tracked NIIN with a real item name', () => {
  const tracked = new Map([['002915924', '5331002915924']]);
  const row = { fsc: '5331', niin: '002915924', itemName: 'O-RING' };
  assert.deepEqual(mapIdentificationRow(row, tracked), {
    nsn: '5331002915924',
    itemName: 'O-RING',
  });
});

test('mapIdentificationRow: skips untracked NIINs (never creates a new NSN)', () => {
  const tracked = new Map([['002915924', '5331002915924']]);
  const row = { fsc: '4935', niin: '000000012', itemName: 'WIDGET' };
  assert.equal(mapIdentificationRow(row, tracked), null);
});

test('mapIdentificationRow: skips when FSC in the row disagrees with the tracked NSN', () => {
  const tracked = new Map([['002915924', '5331002915924']]);
  const row = { fsc: '9999', niin: '002915924', itemName: 'O-RING' };
  assert.equal(mapIdentificationRow(row, tracked), null);
});

test('mapIdentificationRow: skips the literal "NO ITEM NAME AVAILABLE" placeholder', () => {
  const tracked = new Map([['000000012', '4935000000012']]);
  const row = { fsc: '4935', niin: '000000012', itemName: 'NO ITEM NAME AVAILABLE' };
  assert.equal(mapIdentificationRow(row, tracked), null);
});

test('mapIdentificationRow: skips empty item names', () => {
  const tracked = new Map([['000000012', '4935000000012']]);
  const row = { fsc: '4935', niin: '000000012', itemName: '' };
  assert.equal(mapIdentificationRow(row, tracked), null);
});

// ---------------------------------------------------------------------------
// mapPartRow
// ---------------------------------------------------------------------------

test('mapPartRow: maps a tracked NIIN to an insert with a normalized cage', () => {
  const tracked = new Map([['000000042', '5331000000042']]);
  const row = { niin: '000000042', partNumber: 'UK 60A890216', cage: '24039' };
  assert.deepEqual(mapPartRow(row, tracked), {
    nsn: '5331000000042',
    partNumber: 'UK 60A890216',
    cage: '24039',
  });
});

test('mapPartRow: skips untracked NIINs', () => {
  const tracked = new Map();
  const row = { niin: '000000042', partNumber: 'UK 60A890216', cage: '24039' };
  assert.equal(mapPartRow(row, tracked), null);
});

test('mapPartRow: skips rows with no part number', () => {
  const tracked = new Map([['000000042', '5331000000042']]);
  const row = { niin: '000000042', partNumber: '', cage: '24039' };
  assert.equal(mapPartRow(row, tracked), null);
});

test('mapPartRow: sets cage to null (not dropped) when malformed', () => {
  const tracked = new Map([['000000042', '5331000000042']]);
  const row = { niin: '000000042', partNumber: 'UK 60A890216', cage: 'bad-cage' };
  assert.deepEqual(mapPartRow(row, tracked), {
    nsn: '5331000000042',
    partNumber: 'UK 60A890216',
    cage: null,
  });
});

// ---------------------------------------------------------------------------
// mapCageRow
// ---------------------------------------------------------------------------

test('mapCageRow: maps a referenced CAGE', () => {
  const referenced = new Set(['24039']);
  const row = {
    cage: '24039',
    company: 'ACME CO',
    city: 'DAYTON',
    state: 'OH',
    country: 'UNITED STATES',
  };
  assert.deepEqual(mapCageRow(row, referenced), {
    cage: '24039',
    name: 'ACME CO',
    city: 'DAYTON',
    state: 'OH',
    country: 'UNITED STATES',
  });
});

test('mapCageRow: skips CAGE codes that were never referenced by a loaded part number', () => {
  const referenced = new Set(['00000']);
  const row = { cage: '24039', company: 'ACME CO', city: '', state: '', country: '' };
  assert.equal(mapCageRow(row, referenced), null);
});

test('mapCageRow: blank optional fields become null, not empty strings', () => {
  const referenced = new Set(['24039']);
  const row = { cage: '24039', company: '', city: '', state: '', country: '' };
  assert.deepEqual(mapCageRow(row, referenced), {
    cage: '24039',
    name: null,
    city: null,
    state: null,
    country: null,
  });
});

// ---------------------------------------------------------------------------
// mapCharacteristicsRow
// ---------------------------------------------------------------------------

test('mapCharacteristicsRow: maps a tracked row to an {nsn, entry} pair', () => {
  const tracked = new Map([['000000042', '5331000000042']]);
  const row = {
    niin: '000000042',
    mrc: 'ABCD',
    requirement: 'MATERIAL',
    reply: 'RUBBER',
  };
  assert.deepEqual(mapCharacteristicsRow(row, tracked), {
    nsn: '5331000000042',
    entry: { mrc: 'ABCD', requirement: 'MATERIAL', reply: 'RUBBER' },
  });
});

test('mapCharacteristicsRow: skips untracked NIINs', () => {
  const tracked = new Map();
  const row = { niin: '000000042', mrc: 'ABCD', requirement: 'MATERIAL', reply: 'RUBBER' };
  assert.equal(mapCharacteristicsRow(row, tracked), null);
});

test('mapCharacteristicsRow: skips rows with no MRC code', () => {
  const tracked = new Map([['000000042', '5331000000042']]);
  const row = { niin: '000000042', mrc: '', requirement: 'MATERIAL', reply: 'RUBBER' };
  assert.equal(mapCharacteristicsRow(row, tracked), null);
});

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

test('PUBLOG_SOURCE_URL points at the DLA PUB LOG FOIA page', () => {
  assert.match(PUBLOG_SOURCE_URL, /^https:\/\/www\.dla\.mil\//);
});

// ---------------------------------------------------------------------------
// V_MOE_RULE.CSV (AMC / AMSC)
// ---------------------------------------------------------------------------

const fixture = (name) =>
  fileURLToPath(new URL(`../test/fixtures/moe/${name}`, import.meta.url));

const moeTracked = new Map(
  [1, 2, 3, 4, 5].map((i) => [String(i).padStart(9, '0'), `5331${String(i).padStart(9, '0')}`])
);
const quiet = { log: () => {}, today: '2026-10-10' };

test('resolveMoeColumns: resolves by header name, case-insensitively', () => {
  const cols = resolveMoeColumns(['junk', 'moe_code', 'niin', 'Amsc', 'AMC', 'x', 'ROW_OBS_DT', 'y']);
  assert.deepEqual(
    { niin: cols.niin, moe: cols.moe, amc: cols.amc, amsc: cols.amsc, obs: cols.obs },
    { niin: 2, moe: 1, amc: 4, amsc: 3, obs: 6 }
  );
  assert.ok(Object.values(cols.via).every((v) => v === 'header'));
  assert.equal(resolveMoeColumns(['NIIN', 'MOE', 'AMC', 'AMSC', 'LAST_ROW_OBS_DT']).obs, 4);
  assert.equal(resolveMoeColumns(['NIIN', 'MOE_CD', 'AMC', 'AMSC']).moe, 1);
});

test('resolveMoeColumns: falls back to positions 0, 2, 3, 4 and the last column', () => {
  const headers = Array.from({ length: 15 }, (_, i) => `COL_${i}`);
  const cols = resolveMoeColumns(headers);
  assert.deepEqual(
    { niin: cols.niin, moe: cols.moe, amc: cols.amc, amsc: cols.amsc, obs: cols.obs },
    { niin: 0, moe: 2, amc: 3, amsc: 4, obs: 14 }
  );
  assert.ok(Object.values(cols.via).every((v) => v === 'position'));
});

test('resolveMoeColumns: mixes name matches with positional fallback per column', () => {
  const cols = resolveMoeColumns(['NIIN', 'X', 'Y', 'AMC_X', 'AMSC', 'Z']);
  assert.equal(cols.amsc, 4);
  assert.equal(cols.via.amsc, 'header');
  assert.equal(cols.amc, 3);
  assert.equal(cols.via.amc, 'position');
  assert.equal(cols.obs, 5);
});

test('normalizeAmc / normalizeAmsc: reject anything but the documented shapes', () => {
  assert.equal(normalizeAmc(' 2 '), '2');
  assert.equal(normalizeAmc('0'), '0');
  for (const bad of ['6', '9', 'A', '12', '', null, undefined, ' ']) assert.equal(normalizeAmc(bad), null);
  assert.equal(normalizeAmsc('g'), 'G');
  assert.equal(normalizeAmsc('7'), '7');
  for (const bad of ['GG', '?', '', null, undefined, ' ', '-']) assert.equal(normalizeAmsc(bad), null);
});

test('parseObsDate: accepts the plausible shapes, rejects junk and future dates', () => {
  assert.equal(parseObsDate('15-SEP-2026'), '2026-09-15');
  assert.equal(parseObsDate('5-Jan-2025'), '2025-01-05');
  assert.equal(parseObsDate('2026-09-15'), '2026-09-15');
  assert.equal(parseObsDate('2026-09-15 10:11:12'), '2026-09-15');
  assert.equal(parseObsDate('20260915'), '2026-09-15');
  assert.equal(parseObsDate('09/15/2026'), '2026-09-15');
  for (const bad of ['', null, undefined, 'not a date', '31-FEB-2026', '2026-13-01', '99999999']) {
    assert.equal(parseObsDate(bad), null);
  }
  assert.equal(parseObsDate('01-JAN-2099', '2026-10-10'), null);
});

test('mapMoeRuleRow: skips untracked NIINs and rows where AMC and AMSC are both blank', () => {
  const base = { niin: '000000001', moe: 'af', amc: '1', amsc: 'z', obs: '01-JUN-2026' };
  assert.deepEqual(mapMoeRuleRow(base, moeTracked), {
    nsn: '5331000000001', moe: 'AF', amc: '1', amsc: 'Z', date: '2026-06-01',
    amcRejected: false, amscRejected: false,
  });
  assert.equal(mapMoeRuleRow({ ...base, niin: '999999999' }, moeTracked), null);
  assert.equal(mapMoeRuleRow({ ...base, niin: 'bad' }, moeTracked), null);
  assert.equal(mapMoeRuleRow({ ...base, amc: '', amsc: ' ' }, moeTracked), null);
});

test('mapMoeRuleRow: invalid codes become blank; a row with one valid code is kept', () => {
  const base = { niin: '000000001', moe: 'AF', amc: '1', amsc: 'Z', obs: '' };
  const badAmc = mapMoeRuleRow({ ...base, amc: '9' }, moeTracked);
  assert.equal(badAmc.amc, null);
  assert.equal(badAmc.amsc, 'Z');
  assert.equal(badAmc.amcRejected, true);
  const badAmsc = mapMoeRuleRow({ ...base, amsc: '?' }, moeTracked);
  assert.equal(badAmsc.amsc, null);
  assert.equal(badAmsc.amc, '1');
  assert.equal(mapMoeRuleRow({ ...base, amc: '9', amsc: '?' }, moeTracked), null);
});

test('isBetterMoeRow: DS wins; then the later date; then last seen when undated', () => {
  const row = (moe, date) => ({ moe, date });
  assert.equal(isBetterMoeRow(null, row('AF', null)), true);
  assert.equal(isBetterMoeRow(row('AF', '2026-09-01'), row('DS', '2020-01-01')), true);
  assert.equal(isBetterMoeRow(row('DS', '2020-01-01'), row('AF', '2026-09-01')), false);
  assert.equal(isBetterMoeRow(row('DS', '2020-01-01'), row('DS', '2021-01-01')), true);
  assert.equal(isBetterMoeRow(row('AF', '2026-09-01'), row('NV', '2025-01-01')), false);
  assert.equal(isBetterMoeRow(row('AF', null), row('NV', '2025-01-01')), true);
  assert.equal(isBetterMoeRow(row('AF', '2025-01-01'), row('NV', null)), false);
  assert.equal(isBetterMoeRow(row('AF', null), row('NV', null)), true);
});

test('collectMoeRule: sample fixture with named headers (DS pref, date fallback, blanks, invalid codes)', async () => {
  const lines = [];
  const { best, stats, columns } = await collectMoeRule(fixture('V_MOE_RULE.sample.csv'), moeTracked, {
    ...quiet,
    log: (m) => lines.push(m),
  });
  const pick = (n) => {
    const r = best.get(`5331${n}`);
    return r && { amc: r.amc, amsc: r.amsc, date: r.date, moe: r.moe };
  };
  // DS beats a later non-DS row.
  assert.deepEqual(pick('000000001'), { amc: '2', amsc: 'G', date: '2026-09-15', moe: 'DS' });
  // No DS: latest ROW_OBS_DT wins even though it appears later in the file.
  assert.deepEqual(pick('000000002'), { amc: '2', amsc: 'D', date: '2026-06-01', moe: 'NV' });
  // Both codes blank: ignored entirely.
  assert.equal(pick('000000003'), undefined);
  // Invalid AMC (9) -> blank, AMSC kept; the older NV row's '?' AMSC is blank, AMC 3 kept but older.
  assert.deepEqual(pick('000000004'), { amc: null, amsc: 'G', date: '2026-06-01', moe: 'AF' });
  // Two DS rows with unparseable dates: last seen wins.
  assert.deepEqual(pick('000000005'), { amc: '1', amsc: 'Z', date: null, moe: 'DS' });
  assert.equal(best.size, 4);
  assert.equal(stats.scanned, 10);
  assert.equal(stats.blankSkipped, 1);
  assert.equal(stats.amcRejected, 1);
  assert.equal(stats.amscRejected, 1);
  assert.match(columns, /niin=0\(header\) moe=2\(header\) amc=3\(header\) amsc=4\(header\) obs=14\(header\)/);
  assert.ok(lines.some((l) => l.includes('first line:') && l.includes('"NIIN","MOE_RULE_NBR"')));
});

test('collectMoeRule: unknown header names use the positional fallback', async () => {
  const { best, columns } = await collectMoeRule(fixture('V_MOE_RULE.alt-headers.csv'), moeTracked, quiet);
  assert.match(columns, /niin=0\(position\) moe=2\(position\) amc=3\(position\) amsc=4\(position\) obs=14\(position\)/);
  // Rule type column is positional MOE code, so the DS row wins over the newer AF row.
  assert.deepEqual(
    [best.get('5331000000001').amc, best.get('5331000000001').amsc, best.get('5331000000001').moe],
    ['2', 'G', 'DS']
  );
  assert.equal(best.get('5331000000002').amc, '1');
});

test('collectMoeRule: a file with no header row is read positionally and keeps its first row', async () => {
  const { best, columns } = await collectMoeRule(fixture('V_MOE_RULE.noheader.csv'), moeTracked, quiet);
  assert.match(columns, /niin=0\(position\)/);
  assert.equal(best.get('5331000000001').amsc, 'Z');
  assert.equal(best.get('5331000000002').moe, 'DS');
});
