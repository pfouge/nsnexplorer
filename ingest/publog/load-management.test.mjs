// ingest/publog/load-management.test.mjs
// Tests for load-management.mjs on SYNTHETIC rows (the real file layout is unverified, see the loader header).
// Pure tests always run; database tests need a database with migration 0020 applied and TEST_DATABASE_URL set:
//
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_mgmt node --test ingest/publog/load-management.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const mg = await import('./load-management.mjs');
const { getPool, closePool } = await import('../../shared/db.mjs');

const quiet = () => {};
const NOW = new Date('2026-11-15T00:00:00Z');

// ---------------------------------------------------------------------------
// pure
// ---------------------------------------------------------------------------

test('findManagementFiles: only V_FLIS_MANAGEMENT.CSV; service files, FUTURE and others ignored', () => {
  const got = mg.findManagementFiles(['P_CAGE.CSV', 'V_MGMT_NAVY.CSV', 'v_flis_management.csv', 'V_FLIS_MANAGEMENT_FUTURE.CSV', 'V_MGMT_AIR_FORCE.CSV', 'V_MGMT_ARMY_FUTURE.CSV', 'MANAGEMENT.zip']);
  assert.deepEqual(got, [
    { file: 'v_flis_management.csv', source: 'FLIS' },
  ]);
});

test('parsePrice: plain decimals, currency marks, zero, junk, blank', () => {
  assert.deepEqual(mg.parsePrice('12.40'), { value: '12.40', raw: '12.40', plain: false });
  assert.deepEqual(mg.parsePrice(' $1,200.5 '), { value: '1200.5', raw: '$1,200.5', plain: false });
  assert.deepEqual(mg.parsePrice('0'), { value: '0', raw: '0', plain: true });
  assert.deepEqual(mg.parsePrice('0.00'), { value: '0.00', raw: '0.00', plain: false });
  assert.deepEqual(mg.parsePrice(''), { value: null, raw: null, plain: false });
  assert.deepEqual(mg.parsePrice('   '), { value: null, raw: null, plain: false });
  assert.deepEqual(mg.parsePrice('N/A'), { value: null, raw: 'N/A', plain: false });
  assert.deepEqual(mg.parsePrice('-3.00'), { value: null, raw: '-3.00', plain: false });
  assert.deepEqual(mg.parsePrice('1.2.3'), { value: null, raw: '1.2.3', plain: false });
});

test('parseMgmtDate: DD-MON-YYYY, DD-MON-YY, ISO, YYYYMMDD, M/D/YYYY, junk', () => {
  assert.equal(mg.parseMgmtDate('02-JUL-2026', NOW), '2026-07-02');
  assert.equal(mg.parseMgmtDate('15-JUN-97', NOW), '1997-06-15');
  assert.equal(mg.parseMgmtDate('2026-07-02', NOW), '2026-07-02');
  assert.equal(mg.parseMgmtDate('20260702', NOW), '2026-07-02');
  assert.equal(mg.parseMgmtDate('7/2/2026', NOW), '2026-07-02');
  assert.equal(mg.parseMgmtDate('20261340', NOW), null);
  assert.equal(mg.parseMgmtDate('', NOW), null);
  assert.equal(mg.parseMgmtDate('soon', NOW), null);
});

const HEADER = ['NIIN', 'MOE_CD', 'EFF_DATE', 'AAC', 'SOS', 'UI', 'UNIT_PRICE', 'QUP', 'CIIC', 'SLC', 'RC', 'SERVICE_NOTE'];

test('resolveMgmtColumns: by header name, any order, never a guessed position', () => {
  const r = mg.resolveMgmtColumns(HEADER);
  assert.equal(r.hasHeader, true);
  assert.equal(r.cols.unit_price, 6);
  assert.equal(r.cols.slc, 9);
  assert.deepEqual(r.missing, []);
  // reordered, aliases, two columns missing: those are absent, not read from a position
  const odd = mg.resolveMgmtColumns(['SLC', 'Unit_Of_Issue', 'NIIN', 'PRICE', 'WHATEVER']);
  assert.equal(odd.cols.niin, 2);
  assert.equal(odd.cols.ui, 1);
  assert.equal(odd.cols.unit_price, 3);
  assert.equal(odd.cols.sos, -1);
  assert.equal(odd.via.sos, 'absent');
  assert.ok(odd.missing.includes('aac') && odd.missing.includes('ciic'));
  // no header: positional reading is refused by the loader (cols for all but niin are -1)
  const none = mg.resolveMgmtColumns(['000000012', 'DA', '02-JUL-2026']);
  assert.equal(none.hasHeader, false);
  assert.equal(none.cols.unit_price, -1);
});

test('mapManagementRow: tracked, untracked, blank, extra columns', () => {
  const tracked = new Map([['000000012', '4935000000012']]);
  const cols = mg.resolveMgmtColumns(HEADER).cols;
  const row = (...f) => mg.mapManagementRow(f, cols, tracked, 'ARMY', '2026-10-23', HEADER);

  const r = row('000000012', 'da', '02-JUL-2026', 'D', 'S9C', 'EA', '12.40', '1', 'U', 'H', 'Z', 'note');
  assert.deepEqual(r, {
    nsn: '4935000000012', source: 'ARMY', moe_cd: 'DA', effective_date: '2026-07-02', aac: 'D', sos: 'S9C', ui: 'EA',
    unit_price: '12.40', unit_price_raw: '12.40', qup: '1', ciic: 'U', slc: 'H', repairability: 'Z',
    extra: { SERVICE_NOTE: 'note' }, source_file_date: '2026-10-23',
  });
  assert.equal(row('000000099', 'DA', '', 'D', '', 'EA', '1.00', '', '', '', '', ''), null); // untracked NIIN
  assert.equal(row('bad', 'DA', '', 'D', '', 'EA', '1.00', '', '', '', '', ''), null);
  assert.equal(row('000000012', '', '', '', '', '', '', '', '', '', '', 'only a note'), null); // nothing but the key
  const z = row('000000012', '', '', '', '', 'EA', '0.00', '', '', '0', '', '');
  assert.equal(z.moe_cd, '');
  assert.equal(z.unit_price, '0.00');
  assert.equal(z.slc, '0');
  assert.equal(z.extra, null);
  const junk = row('000000012', '', '', '', '', 'EA', 'call', '', '', '', '', '');
  assert.equal(junk.unit_price, null);
  assert.equal(junk.unit_price_raw, 'call');
});

test('priceStats: counts priced, zero, blank, unparsable, no decimal point', () => {
  const rows = ['12.40', '0.00', null, 'call', '300', '7.5'].map((p) => ({ unit_price: p === null || p === 'call' ? null : p, unit_price_raw: p }));
  assert.deepEqual(mg.priceStats(rows), { rows: 6, priced: 3, zero: 1, blank: 1, unparsable: 1, noDecimalPoint: 1, min: 7.5, max: 300, median: 12.4 });
});

test('upsert spec: key (nsn, source, moe_cd), unchanged rows are skipped', async () => {
  const { buildUpsert } = await import('./load-flis.mjs');
  const sql = buildUpsert(mg.MGMT_UPSERT);
  assert.match(sql, /INSERT INTO pub\.nsn_management/);
  assert.match(sql, /ON CONFLICT \(nsn, source, moe_cd\) DO UPDATE/);
  assert.match(sql, /updated_at = now\(\)/);
  assert.match(sql, /IS DISTINCT FROM/);
});

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

const dbTest = url ? test : test.skip;
const NSNS = { a: '5340990000012', b: '5340990000024', c: '5340990000036' };
const dir = mkdtempSync(path.join(tmpdir(), 'mgmt-'));
const wr = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };
const hdr = '"NIIN","MOE_CD","EFF_DATE","AAC","SOS","UI","UNIT_PRICE","QUP","CIIC","SLC","RC","SERVICE_NOTE"\n';

const FLIS_FILE =
  hdr +
  '"990000012","","02-JUL-2026","D","S9C","EA","20.00","1","U","H","Z","n1"\n' +
  '"990000024","","15-JUN-97","J","N32","BX","0.00","10","","0","",""\n' +
  '"990000099","","02-JUL-2026","D","S9C","EA","5.00","1","U","H","Z",""\n' + // untracked
  '"990000036","","","","","","","","","","","only a note"\n' + // key only
  '"990000012","","02-JUL-2026","D","S9C","EA","20.00","1","U","H","Z","n1"\n' + // repeated key
  '\n' +
  '"990000012","DA","bad date","D","S9C","EA","oops","","","","",""\n';
const ARMY_FILE = hdr + '"990000012","","01-JAN-2026","","","EA","18.25","","","F","",""\n';

async function setup() {
  const pool = getPool();
  await pool.query(`DELETE FROM pub.nsns WHERE nsn = ANY($1)`, [Object.values(NSNS)]); // cascades to pub.nsn_management
  await pool.query(`INSERT INTO pub.fsc (fsc, name) VALUES ('5340', 'test') ON CONFLICT (fsc) DO NOTHING`);
  await pool.query(`INSERT INTO pub.nsns (nsn, fsc) SELECT x, '5340' FROM unnest($1::text[]) x`, [Object.values(NSNS)]);
}
const rows = async (nsn) => (await getPool().query(`SELECT * FROM pub.nsn_management WHERE nsn = $1 ORDER BY source, moe_cd`, [nsn])).rows;

dbTest('loadManagementFile: tracked only, parsing, extra, repeated key, idempotent', async () => {
  await setup();
  const tracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
  const f = wr('V_FLIS_MANAGEMENT.CSV', FLIS_FILE);
  const r1 = await mg.loadManagementFile(f, 'FLIS', tracked, { log: quiet, sourceFileDate: '2026-10-23' });
  assert.equal(r1.kept, 4); // NIIN ...012 (twice, plus once with moe code DA) and ...024; the untracked and the key-only rows are skipped
  assert.equal(r1.dupKeys, 1);
  const a = await rows(NSNS.a);
  assert.deepEqual(a.map((r) => [r.source, r.moe_cd]), [['FLIS', ''], ['FLIS', 'DA']]);
  assert.equal(a[0].unit_price, '20.00');
  assert.equal(a[0].unit_price_raw, '20.00');
  assert.equal(a[0].ui, 'EA');
  assert.equal(a[0].slc, 'H');
  assert.equal(a[0].effective_date.toISOString().slice(0, 10), '2026-07-02');
  assert.deepEqual(a[0].extra, { SERVICE_NOTE: 'n1' });
  assert.equal(a[1].unit_price, null);
  assert.equal(a[1].unit_price_raw, 'oops');
  assert.equal(a[1].effective_date, null);
  const b = (await rows(NSNS.b))[0];
  assert.equal(b.unit_price, '0.00');
  assert.equal(b.slc, '0');
  assert.equal(b.effective_date.toISOString().slice(0, 10), '1997-06-15');
  assert.equal((await rows(NSNS.c)).length, 0);
  assert.equal((await getPool().query(`SELECT count(*) FROM pub.nsn_management WHERE nsn = '5340990000099'`)).rows[0].count, '0');

  const again = await mg.loadManagementFile(f, 'FLIS', tracked, { log: quiet, sourceFileDate: '2026-10-23' });
  assert.equal(again.written, 0);
});

dbTest('loadManagement: FLIS + service file are different keys; a bad file is a warning, the rest loads; all bad throws', async () => {
  await setup();
  const tracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
  const d = mkdtempSync(path.join(tmpdir(), 'mgmt-dir-'));
  writeFileSync(path.join(d, 'V_FLIS_MANAGEMENT.CSV'), FLIS_FILE);
  writeFileSync(path.join(d, 'V_MGMT_ARMY.CSV'), ARMY_FILE);
  writeFileSync(path.join(d, 'V_MGMT_NAVY.CSV'), '"990000012","","01-JAN-2026","","","EA","9.99"\n'); // headerless: refused
  const logs = [];
  const files = mg.findManagementFiles(['V_FLIS_MANAGEMENT.CSV', 'V_MGMT_ARMY.CSV', 'V_MGMT_NAVY.CSV']);
  const res = await mg.loadManagement(d, files, tracked, { log: (m) => logs.push(m), sourceFileDate: '2026-10-23' });
  assert.equal(res.kept, 5);
  assert.ok(logs.some((l) => /::warning::.*V_MGMT_NAVY\.CSV load failed .*no header row/.test(l)));
  assert.ok(logs.some((l) => /first line: "NIIN","MOE_CD"/.test(l)));
  assert.ok(logs.some((l) => /unit price: \{"rows":/.test(l)));
  assert.ok(logs.some((l) => /sample mapped row/.test(l)));
  const a = await rows(NSNS.a);
  assert.deepEqual(a.map((r) => `${r.source}/${r.moe_cd}`), ['ARMY/', 'FLIS/', 'FLIS/DA']);
  assert.equal(a[0].unit_price, '18.25');
  await assert.rejects(mg.loadManagement(d, mg.findManagementFiles(['V_MGMT_NAVY.CSV']), tracked, { log: quiet }), /no header row/);
  rmSync(d, { recursive: true });
});

dbTest('loadManagement: price column not found is a warning, other columns still load', async () => {
  await setup();
  const tracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
  const d = mkdtempSync(path.join(tmpdir(), 'mgmt-nop-'));
  writeFileSync(path.join(d, 'V_FLIS_MANAGEMENT.CSV'), '"NIIN","SLC","UI"\n"990000012","H","EA"\n');
  const logs = [];
  await mg.loadManagement(d, mg.findManagementFiles(['V_FLIS_MANAGEMENT.CSV']), tracked, { log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /::warning::.*columns not found by header name: .*unit_price/.test(l)));
  assert.equal((await rows(NSNS.a))[0].slc, 'H');
  rmSync(d, { recursive: true });
});

dbTest('main(): a missing management zip is only a warning; present files load via load.mjs', async () => {
  await setup();
  const d = mkdtempSync(path.join(tmpdir(), 'mgmt-main-'));
  writeFileSync(path.join(d, 'P_FLIS_NSN.CSV'), '"FSC","NIIN","INC","ITEM_NAME","SOS","END_ITEM_NAME","CANCELLED_NIIN"\n"5340","990000012","77777","BRACKET","","",""\n');
  const run = () => execFileSync('node', [fileURLToPath(new URL('./load.mjs', import.meta.url)), '--dir', d], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  const out1 = run();
  assert.match(out1, /::warning::load\.mjs: no V_FLIS_MANAGEMENT\.CSV \/ V_MGMT_\*\.CSV/);
  writeFileSync(path.join(d, 'V_FLIS_MANAGEMENT.CSV'), FLIS_FILE);
  const out2 = run();
  assert.match(out2, /management files: \d+ kept, \d+ written/);
  assert.equal((await rows(NSNS.a)).length, 2);
  rmSync(d, { recursive: true });
});

test.after(async () => {
  if (url) {
    await getPool().query(`DELETE FROM pub.amsc_observations WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
    await getPool().query(`DELETE FROM pub.part_numbers WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
    await getPool().query(`DELETE FROM pub.nsns WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
  }
  await closePool();
  rmSync(dir, { recursive: true, force: true });
});
