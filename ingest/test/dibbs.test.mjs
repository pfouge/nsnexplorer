import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwardGrid, parseRfqGrid, LAYOUT_CONFIRMED } from '../dibbs/parse.mjs';
import * as load from '../dibbs/load.mjs';

const { loadAwardRecords } = load;

test('parse.mjs: LAYOUT_CONFIRMED is true (the grid layout was confirmed against live captures)', () => {
  assert.equal(LAYOUT_CONFIRMED, true);
});

// The delimited/fixed-width text-file parsers (parseAwardFile, parseRfqFile) no longer exist: DIBBS is read
// from its GridView pages (parseAwardGrid, parseRfqGrid). These tests cover the same ground on the grid parsers
// with small inline pages; the committed full-page fixtures are covered in ingest/dibbs/*.test.mjs.
const rfqRow = (n, nsn, sol) => `
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblRowNum">${n}</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblNsn">${nsn}</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblNomenclature">WIDGET</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblSolicitation">${sol}</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblStatus">Open</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblPr">7017750970 QTY: 240</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblIssued">09-03-2026</span>
<span id="ctl00_cph1_grdRfqSearch_ctl0${n}_lblReturnBy">09-17-2026</span>`;

test('parseRfqGrid: reads rows from a small inline grid, with and without the attachments marker', () => {
  const html = rfqRow(3, '8410-01-732-9585', "<a href='x'>SPE1C1-26-Q-0487<br />--&raquo;Attachments</a>") +
    rfqRow(4, '8410-01-732-9589', "<a href='x'>SPE1C1-26-Q-0488</a>");
  const { records, recordCount } = parseRfqGrid(html);
  assert.equal(recordCount, 2);
  assert.deepEqual(records.map((r) => r.solicitation), ['SPE1C1-26-Q-0487', 'SPE1C1-26-Q-0488']);
  assert.deepEqual(records.map((r) => r.nsnRaw), ['8410017329585', '8410017329589']);
  assert.equal(records[0].quantity, 240);
  assert.equal(records[0].returnBy, '2026-09-17');
});

test('parseRfqGrid and parseAwardGrid: a page without grid rows yields no records', () => {
  assert.deepEqual(parseRfqGrid('<html><body>No records</body></html>'), { records: [], recordCount: 0 });
  assert.deepEqual(parseAwardGrid('<html><body>No records</body></html>'), { records: [], recordCount: 0 });
});

test('load.mjs: with the layout confirmed, loadAwardRecords on no records loads nothing and needs no database', async () => {
  assert.deepEqual(await loadAwardRecords([]), { loaded: 0, skipped: [] });
});

test('load.mjs: the RFQ loader is loadRfqSolicitations (not gated on the layout flag); the old loadRfqRecords is gone', () => {
  assert.equal(typeof load.loadRfqSolicitations, 'function');
  assert.equal(load.loadRfqRecords, undefined);
});
