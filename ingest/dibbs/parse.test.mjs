// ingest/dibbs/parse.test.mjs
// node:test suite for parse.mjs, run against the committed live-capture
// fixture ingest/dibbs/fixtures/awd-grid-p1.html (see
// docs/dibbs-ingest-findings.md "Award grid — CONFIRMED").
//
// Run: node --test ingest/dibbs/parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAwardGrid, parsePagination, extractAspNetForm } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'awd-grid-p1.html');

async function loadFixture() {
  return readFile(FIXTURE_PATH, 'utf8');
}

test('parseAwardGrid returns exactly 50 records', async () => {
  const html = await loadFixture();
  const { records, recordCount } = parseAwardGrid(html);
  assert.equal(records.length, 50);
  assert.equal(recordCount, 50);
});

test('parseAwardGrid: record 1 matches known values', async () => {
  const html = await loadFixture();
  const { records } = parseAwardGrid(html);
  const first = records[0];

  assert.equal(first.total, 8644.84);
  assert.equal(first.awardDate, '2026-07-10');
  assert.equal(first.nsnRaw, '6130015649082');
  assert.equal(first.nomenclature, 'CHARGER, BATTERY');
  assert.equal(first.purchaseRequest, '7015819485');
  assert.equal(first.solicitation, 'SPE7L726T2303');
});

test('parseAwardGrid: a record with "&nbsp;" solicitation yields null', async () => {
  const html = await loadFixture();
  const { records } = parseAwardGrid(html);
  // Row 2 in the fixture (ctl04) has <span ...lblSolicitation>&nbsp;</span>.
  const second = records[1];
  assert.equal(second.solicitation, null);
});

test('parseAwardGrid: total is null when unparseable (e.g. "See Award Doc")', async () => {
  const html = await loadFixture();
  const { records } = parseAwardGrid(html);
  const withUnparseableTotal = records.find((r) => r.total === null);
  assert.ok(withUnparseableTotal, 'expected at least one record with an unparseable total');
});

test('parsePagination finds Page$2..Page$11 and the grid id', async () => {
  const html = await loadFixture();
  const { gridId, pages } = parsePagination(html);

  assert.equal(gridId, 'ctl00$cph1$grdAwardSearch');
  const expected = Array.from({ length: 10 }, (_, i) => `Page$${i + 2}`); // Page$2..Page$11
  for (const p of expected) {
    assert.ok(pages.includes(p), `expected pages to include ${p}, got ${JSON.stringify(pages)}`);
  }
});

test('extractAspNetForm returns viewstate field count, split parts, generator, and event validation', async () => {
  const html = await loadFixture();
  const { fields } = extractAspNetForm(html);

  // NOTE: the task spec that seeded this suite assumed __VIEWSTATEFIELDCOUNT
  // '36'. The committed live fixture actually carries 931 split VIEWSTATE
  // parts (__VIEWSTATE + __VIEWSTATE1..__VIEWSTATE930) — a much larger page
  // than assumed, presumably because this grid page (3602 total award
  // records across ~73 pages) has a heavier ViewState payload than whatever
  // page the '36' assumption was based on. Asserting against the real,
  // committed fixture rather than the assumed number.
  assert.equal(fields.__VIEWSTATEFIELDCOUNT, '931');

  const viewStateParts = Object.keys(fields).filter((k) => /^__VIEWSTATE\d*$/.test(k));
  assert.equal(viewStateParts.length, 931);

  assert.ok(typeof fields.__VIEWSTATEGENERATOR === 'string' && fields.__VIEWSTATEGENERATOR.length > 0);
  assert.ok(typeof fields.__EVENTVALIDATION === 'string' && fields.__EVENTVALIDATION.length > 0);
});
