import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNsn, dashNsn, niinOf, extractNiin } from '../nsn.mjs';

test('normalizeNsn: accepts 13 bare digits', () => {
  assert.equal(normalizeNsn('5331002915924'), '5331002915924');
});

test('normalizeNsn: accepts dashed 4-2-3-4', () => {
  assert.equal(normalizeNsn('5331-00-291-5924'), '5331002915924');
});

test('normalizeNsn: accepts spaced groups', () => {
  assert.equal(normalizeNsn('5331 00 291 5924'), '5331002915924');
});

test('normalizeNsn: accepts mixed dash/space with surrounding whitespace', () => {
  assert.equal(normalizeNsn('  5331-00 291-5924  '), '5331002915924');
});

test('normalizeNsn: rejects wrong digit count', () => {
  assert.equal(normalizeNsn('533100291592'), null); // 12 digits
  assert.equal(normalizeNsn('53310029159245'), null); // 14 digits
});

test('normalizeNsn: rejects non-digit content', () => {
  assert.equal(normalizeNsn('5331-00-291-592X'), null);
  assert.equal(normalizeNsn(null), null);
  assert.equal(normalizeNsn(undefined), null);
});

test('dashNsn: formats 13-digit NSN', () => {
  assert.equal(dashNsn('5331002915924'), '5331-00-291-5924');
});

test('dashNsn: returns null for invalid input', () => {
  assert.equal(dashNsn('123'), null);
});

test('niinOf: extracts last 9 digits', () => {
  assert.equal(niinOf('5331002915924'), '002915924');
});

test('extractNiin: full 13-digit NSN in free text (dashed)', () => {
  assert.equal(extractNiin('NSN 5331-00-291-5924 O-RING'), '002915924');
});

test('extractNiin: full 13-digit NSN in free text (plain)', () => {
  assert.equal(extractNiin('5331002915924!O-RING'), '002915924');
});

test('extractNiin: DLA award description with a 10-digit PR-number trap does not match', () => {
  // The token before '!' is a 10-digit purchase-request number, not a NIIN.
  // Must not truncate it to 9 digits.
  assert.equal(extractNiin('8510240410!O-RING'), null);
});

test('extractNiin: standalone delimited 9-digit NIIN', () => {
  assert.equal(extractNiin('NIIN 002915924 assigned'), '002915924');
});

test('extractNiin: standalone 9-digit NIIN at string boundaries', () => {
  assert.equal(extractNiin('002915924'), '002915924');
});

test('extractNiin: 9-digit run embedded in a longer digit run is not matched', () => {
  assert.equal(extractNiin('1234567890123'.slice(0, 10) + '!X'), null); // 10 digits + '!'
  assert.equal(extractNiin('99002915924!X'), null); // 11 digits before '!'
});

test('extractNiin: returns null when nothing plausible is present', () => {
  assert.equal(extractNiin('O-RING NO NUMBERS HERE'), null);
  assert.equal(extractNiin(''), null);
  assert.equal(extractNiin(null), null);
});

test('extractNiin: prefers a 13-digit NSN match over a coincidental embedded 9-digit-looking substring', () => {
  assert.equal(extractNiin('part 5331-00-291-5924 rev A'), '002915924');
});
