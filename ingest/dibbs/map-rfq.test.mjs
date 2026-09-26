// ingest/dibbs/map-rfq.test.mjs
// node:test suite for mapRfqRecord (map-rfq.mjs), run against the committed
// live-capture fixture ingest/dibbs/fixtures/rfq-grid-p1.html. Pure mapping
// logic only — no DB access.
//
// Run: node --test ingest/dibbs/map-rfq.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRfqGrid } from './parse.mjs';
import { mapRfqRecord } from './map-rfq.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RFQ_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'rfq-grid-p1.html');

// Fixed for deterministic tests — the fixture was captured 2026-07-16/17
// (see rfq-parse.test.mjs).
const TODAY = '2026-07-16';

async function loadRfqFixture() {
  return readFile(RFQ_FIXTURE_PATH, 'utf8');
}

test('parseRfqGrid fixture parses to exactly 50 records', async () => {
  const html = await loadRfqFixture();
  const { records, recordCount } = parseRfqGrid(html);
  assert.equal(records.length, 50);
  assert.equal(recordCount, 50);
});

test('mapRfqRecord: the sample NSN 8455-01-024-2960 row (Removed) maps to a cancelled solicitation', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  const first = records[0];

  // Sanity-check the raw parse first (matches rfq-parse.test.mjs's known
  // values for this row).
  assert.equal(first.nsnRaw, '8455010242960');
  assert.equal(first.solicitation, 'SPE1C1-26-Q-0372');
  assert.equal(first.status, 'Removed');

  const result = mapRfqRecord(first, { today: TODAY });
  assert.ok(!result.skip, `expected a mapped row, got skip: ${result.skip}`);

  assert.equal(result.nsn, '8455010242960');
  assert.equal(result.fsc, '8455');
  assert.equal(result.row.sol_number, 'SPE1C1-26-Q-0372');
  assert.equal(result.row.nsn, '8455010242960');
  assert.equal(result.row.fsc, '8455');
  assert.equal(result.row.quantity, 20000);
  assert.equal(result.row.return_by, '2026-07-22');
  assert.equal(result.row.status, 'cancelled');
  assert.equal(result.row.source, 'dibbs_rfq');
  assert.equal(
    result.row.source_url,
    'https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=8455010242960&category=nsn'
  );
  assert.equal(result.row.raw, first);
});

test('mapRfqRecord: a valid-NSN row with status Open and a future return_by maps to open', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);

  // ctl06 (records[3]) is 'Open' with returnBy 2026-07-23 — after TODAY.
  // (status text includes the trailing "Quote" link text the grid packs
  // into the same cell — 'Open uote' after tag-stripping — so we only
  // assert it does NOT read 'Removed'.)
  const openRec = records[3];
  assert.match(openRec.status, /^Open\b/);
  assert.notEqual(openRec.status.trim().toLowerCase(), 'removed');
  assert.equal(openRec.returnBy, '2026-07-23');
  assert.match(openRec.nsnRaw, /^\d{13}$/);

  const result = mapRfqRecord(openRec, { today: TODAY });
  assert.ok(!result.skip, `expected a mapped row, got skip: ${result.skip}`);
  assert.equal(result.row.status, 'open');
});

test('mapRfqRecord: non-13-digit nsnRaw rows are skipped with reason non-nsn', () => {
  const nonNsnRecord = {
    nsnRaw: 'DA10V00014345',
    nsnQualifier: null,
    nomenclature: 'WIDGET',
    techDocs: null,
    solicitation: 'SPE1C1-26-Q-9999',
    status: 'Open',
    purchaseRequest: '1234567890',
    quantity: 5,
    issued: '2026-07-01',
    returnBy: '2026-08-01',
  };
  const result = mapRfqRecord(nonNsnRecord, { today: TODAY });
  assert.equal(result.skip, 'non-nsn');

  const shortDigits = { ...nonNsnRecord, nsnRaw: '123456789012' }; // 12 digits
  assert.equal(mapRfqRecord(shortDigits, { today: TODAY }).skip, 'non-nsn');

  const nullNsn = { ...nonNsnRecord, nsnRaw: null };
  assert.equal(mapRfqRecord(nullNsn, { today: TODAY }).skip, 'non-nsn');
});

test('mapRfqRecord: every parsed fixture row is either mapped with a 13-digit nsn or skipped as non-nsn/no-sol', async () => {
  const html = await loadRfqFixture();
  const { records } = parseRfqGrid(html);
  for (const rec of records) {
    const result = mapRfqRecord(rec, { today: TODAY });
    if (result.skip) {
      assert.ok(['non-nsn', 'no-sol'].includes(result.skip));
    } else {
      assert.match(result.nsn, /^\d{13}$/);
      assert.ok(['open', 'cancelled', 'expired'].includes(result.row.status));
    }
  }
});
