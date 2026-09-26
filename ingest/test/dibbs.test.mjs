import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwardFile, parseRfqFile, LAYOUT_CONFIRMED } from '../dibbs/parse.mjs';
import { loadAwardRecords, loadRfqRecords } from '../dibbs/load.mjs';

test('parse.mjs: LAYOUT_CONFIRMED is false until a real sample is confirmed', () => {
  assert.equal(LAYOUT_CONFIRMED, false);
});

test('parseAwardFile: detects comma-delimited layout', () => {
  const text = 'SOL1,5331002915924,20260101,10,3.50,35.00,1A2B3,O-RING,G\n' +
    'SOL2,5330012345678,20260102,5,7.25,36.25,4C5D6,GASKET,B\n';
  const result = parseAwardFile(text);
  assert.equal(result.layoutGuess.kind, 'delimited');
  assert.equal(result.layoutGuess.delimiter, ',');
  assert.equal(result.layoutGuess.fileType, 'awd');
  assert.equal(result.records.length, 2);
  assert.equal(result.unparsed.length, 0);
});

test('parseAwardFile: detects pipe-delimited layout', () => {
  const text = 'SOL1|5331002915924|20260101|10|3.50\nSOL2|5330012345678|20260102|5|7.25\n';
  const result = parseAwardFile(text);
  assert.equal(result.layoutGuess.kind, 'delimited');
  assert.equal(result.layoutGuess.delimiter, '|');
  assert.equal(result.records.length, 2);
});

test('parseRfqFile: unrecognized layout falls back to fixed-width and reports unparsed lines', () => {
  const text = 'SOL1 5331002915924 20260101 open\nSOL2 5330012345678 20260102 open\n';
  const result = parseRfqFile(text);
  assert.equal(result.layoutGuess.kind, 'fixed-width');
  assert.equal(result.records.length, 0);
  assert.equal(result.unparsed.length, 2);
});

test('load.mjs: loadAwardRecords refuses to run before layout is confirmed', async () => {
  await assert.rejects(() => loadAwardRecords([]), /LAYOUT_UNCONFIRMED/);
});

test('load.mjs: loadRfqRecords refuses to run before layout is confirmed', async () => {
  await assert.rejects(() => loadRfqRecords([]), /LAYOUT_UNCONFIRMED/);
});
