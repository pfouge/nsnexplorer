// ingest/publog/load.test.mjs
// Pure-function tests for load.mjs. None of these touch Postgres: the CSV
// line splitter and the row-mapping helpers are plain functions with no DB
// access, which is exactly what lets them be tested without a database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCsvLine,
  normalizeCage,
  mapIdentificationRow,
  mapPartRow,
  mapCageRow,
  mapCharacteristicsRow,
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
