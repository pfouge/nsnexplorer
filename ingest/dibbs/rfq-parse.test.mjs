// ingest/dibbs/rfq-parse.test.mjs
// node:test suite for parseRfqGrid (parse.mjs), run against the committed
// live-capture fixture ingest/dibbs/fixtures/rfq-grid-p1.html, plus a join
// smoke test against join-validate.mjs's joinAwardRfq.
//
// Run: node --test ingest/dibbs/rfq-parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAwardGrid, parseRfqGrid } from './parse.mjs';
import { joinAwardRfq } from './join-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RFQ_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'rfq-grid-p1.html');
const AWD_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'awd-grid-p1.html');

async function loadRfqFixture() {
  return readFile(RFQ_FIXTURE_PATH, 'utf8');
}

async function loadAwardFixture() {
  return readFile(AWD_FIXTURE_PATH, 'utf8');
}

test('parseRfqGrid returns exactly 50 records', async () => {
  const html = await loadRfqFixture();
  const { records, recordCount } = parseRfqGrid(html);
  // Verified directly against the fixture: 50 distinct
  // ctl00_cph1_grdRfqSearch_ctlNN_lblRowNum row ids (ctl03..ctl52).
  assert.equal(records.length, 50);
  assert.equal(recordCount, 50);
});

test('parseRfqGrid: record 1 (the first row in document order) matches known values', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  const first = records[0];

  // The fixture's first grid row (ctl03) is DIBBS internal RowNum 910
  // (grid rows are not in RowNum order) — an NSN 8455-01-024-2960 line
  // with a 'Mil-Spec' qualifier, solicitation SPE1C1-26-Q-0372, PR
  // 7017413272 / QTY 20000. Confirmed by direct inspection of the fixture,
  // not assumed.
  assert.equal(first.nsnRaw, '8455010242960');
  assert.equal(first.nsnQualifier, 'Mil-Spec');
  assert.equal(first.nomenclature, 'INSIGNIA, GRADE, ENLISTE');
  assert.equal(first.techDocs, null);
  assert.equal(first.solicitation, 'SPE1C1-26-Q-0372');
  assert.equal(first.status, 'Removed');
  assert.equal(first.purchaseRequest, '7017413272');
  assert.equal(first.quantity, 20000);
  assert.equal(first.issued, '2026-07-15');
  assert.equal(first.returnBy, '2026-07-22');
});

test('parseRfqGrid: solicitation is cleaned of the "» Package View" suffix', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  for (const r of records) {
    if (r.solicitation !== null) {
      assert.ok(!r.solicitation.includes('»'), `solicitation ${r.solicitation} still has a raquo suffix`);
      assert.ok(!r.solicitation.includes('Package View'), `solicitation ${r.solicitation} still has the Package View link text`);
    }
  }
});

test('parseRfqGrid: nsnRaw is 13 digits for every dashed-NSN row in the fixture', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  // Every row in this fixture happens to carry a well-formed dashed NSN
  // (confirmed by inspection), so every nsnRaw should be a compact 13-digit
  // string.
  for (const r of records) {
    assert.match(r.nsnRaw, /^\d{13}$/, `expected 13-digit nsnRaw, got ${r.nsnRaw}`);
  }
});

test('parseRfqGrid: techDocs is null only for &nbsp; cells, not for "None"', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  const withNone = records.find((r) => r.techDocs === 'None');
  assert.ok(withNone, 'expected at least one record with techDocs "None"');
});

test('parseRfqGrid: every record has a non-null purchaseRequest and numeric quantity', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  for (const r of records) {
    assert.notEqual(r.purchaseRequest, null);
    assert.equal(typeof r.quantity, 'number');
    assert.ok(Number.isFinite(r.quantity));
  }
});

test('join smoke test: parseAwardGrid + parseRfqGrid + joinAwardRfq on the two fixtures does not throw and returns the classification structure', async () => {
  const [awdHtml, rfqHtml] = await Promise.all([loadAwardFixture(), loadRfqFixture()]);
  const { records: awards } = parseAwardGrid(awdHtml);
  const { records: rfqs } = parseRfqGrid(rfqHtml);

  assert.ok(awards.length > 0);
  assert.ok(rfqs.length > 0);

  const result = joinAwardRfq(awards, rfqs);

  // Structure, not counts: the two fixtures are captures from different
  // dates (awd-grid-p1.html is 07-10-2026, rfq-grid-p1.html is
  // 07-16/07-17-2026), so real solicitation/PR pairs are not expected to
  // line up and match counts may legitimately be zero.
  assert.ok(Array.isArray(result.matched_ok));
  assert.ok(Array.isArray(result.matched_implausible));
  assert.ok(Array.isArray(result.unmatched_award));
  assert.equal(typeof result.rfq_unmatched, 'number');

  assert.ok(result.totals);
  assert.equal(result.totals.awards, awards.length);
  assert.equal(result.totals.rfqs, rfqs.length);
  assert.equal(result.totals.matched_ok, result.matched_ok.length);
  assert.equal(result.totals.matched_implausible, result.matched_implausible.length);
  assert.equal(result.totals.unmatched_award, result.unmatched_award.length);
  assert.equal(result.totals.rfq_unmatched, result.rfq_unmatched);

  // Every award record must land in exactly one bucket.
  assert.equal(
    result.matched_ok.length + result.matched_implausible.length + result.unmatched_award.length,
    awards.length
  );

  for (const entry of result.matched_ok) {
    assert.ok('nsn' in entry && 'solicitation' in entry && 'pr' in entry);
    assert.ok('total' in entry && 'quantity' in entry && 'unitPrice' in entry);
    assert.ok(entry.unitPrice > 0 && entry.unitPrice <= entry.total);
  }
  for (const entry of result.matched_implausible) {
    assert.ok(Array.isArray(entry.reasons) && entry.reasons.length > 0);
  }
});
