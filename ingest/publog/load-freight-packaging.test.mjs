// ingest/publog/load-freight-packaging.test.mjs
// Tests for load-freight-packaging.mjs. Pure tests use the real sample lines of FREIGHT_PACKAGING.zip (read
// 2026-11-16); the V_DSS_WEIGHT_AND_CUBE.CSV lines are synthetic (that file is not published today).
// Pure tests always run; database tests need a database with migration 0023 applied and TEST_DATABASE_URL set:
//
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_fp node --test ingest/publog/load-freight-packaging.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const fp = await import('./load-freight-packaging.mjs');
const { splitCsvLine } = await import('./load.mjs');
const { resolveColumns } = await import('./load-flis.mjs');
const { getPool, closePool } = await import('../../shared/db.mjs');

const quiet = () => {};

// Real headers and sample lines.
const H1 = '"NIIN","PICA_SICA","PKG_CAT","UNPKG_ITEM_WEIGHT","UNPKG_ITEM_WIDTH","UNPKG_ITEM_LENGTH","UNPKG_ITEM_HEIGHT","UI","TOS","ICQ","MOP","CLNG_DRYING","PRES_MAT","WRAP_MAT","CUSH_DUN","THK","UNIT_CONT","PKG_DATA_SOURCE"';
const H2 = '"NIIN","PICA_SICA","SPC_MKG","INTER_CONT","UCL","LVL_A","LVL_B","LVL_C","UNIT_PACK_WEIGHT","UP_SZ_MAXB","UP_SZ_MAXL","UP_SZ_MAXH","UNIT_PACK_CUBE","OPI","SUPPLEMENTAL_INSTRUCTIONS"';
const H3 = '"NIIN","PICA_SICA","PKG_DESIGN_ACTY","SPI_NO","SPI_REV","SPI_DATE","CONT_NSN"';
const HF = '"NIIN","ACTY_CD","NMFC","NMFC_SUB","UFC","HMC","LTL","LCL","RVC","WCC","TCC","SHC","ADC","ACC","INTEG","NMF_DESC"';
const HD = '"NIIN","DSS_WEIGHT","DSS_CUBE"';
const P1 = [
  '"000000121","P","69Z0","1.0000","5.000","7.500","1.500","EA","A","AAA","GX","1","00","K3","NB","A","NS","P"',
  '"000182463","P","","0.0000","0.000","0.000","0.000","","B","000","10","1","00","00","NA","C","D3","P"',
  '"000345257","P","27AZ","0.0000","0.000","0.000","0.000","","A","ZZZ","ZZ","Z","ZZ","ZZ","ZZ","Z","ZZ","P"',
];
const P2 = [
  '"000000050","P","ZZ","00","A","","","","1350.0000","63.30000","95.00000","47.60000","165.6490","A",""',
  '"000182463","P","00","00","","Q","Q","","1.5000","0.00000","0.00000","0.00000","0.0070","O","IP056: MERCURY OR MERCURY"',
  '"000000051","P","36","ZZ","","Q","Q","","0.1000","0.00000","0.00000","0.00000","0.0010","M","------  HAZARDOUS MATERIAL"',
];
const P3 = [
  '"000000050","P","","F004546662","D","89326",""',
  '"012079082","P","14153","AM12529566","D","25267",""',
  '"000000051","P","14933","","","00000",""',
];
const P3_EMPTY = '"000000051","P","","","","00000",""'; // constructed: only the SPI_DATE placeholder
const FR = [
  '"000000048","CT","120800","Z","61410","","W","M","1","593","Z","9","A","VZ","","ENGINES, INTERNAL COMBUSTION, NOI"',
  '"000000050","TG","118100","Z","60340","","W","","","594","R","D","Z","VD","","COMPRESSORS, AIR, NOI, OR AIR ENDS"',
  '"000000042","9Z","","","","","","","","","","","","","",""',
];
const NIINS = ['000000121', '000182463', '000345257', '000000050', '000000051', '012079082', '000000048', '000000042'];
const tracked = new Map(NIINS.map((n) => [n, `5340${n}`]));
const colsOf = (layout, header) => resolveColumns(layout, splitCsvLine(header), 'niin').cols;
const fields = (line) => splitCsvLine(line);

// ---------------------------------------------------------------------------
// pure
// ---------------------------------------------------------------------------

test('parseMeasure: plain decimals kept as written, zero / blank / junk -> null', () => {
  assert.equal(fp.parseMeasure('1350.0000'), '1350.0000');
  assert.equal(fp.parseMeasure(' 63.30000 '), '63.30000');
  assert.equal(fp.parseMeasure('0.0070'), '0.0070');
  assert.equal(fp.parseMeasure('7'), '7');
  assert.equal(fp.parseMeasure('0.0000'), null);
  assert.equal(fp.parseMeasure('0'), null);
  assert.equal(fp.parseMeasure('000.000'), null);
  assert.equal(fp.parseMeasure(''), null);
  assert.equal(fp.parseMeasure('   '), null);
  assert.equal(fp.parseMeasure(undefined), null);
  assert.equal(fp.parseMeasure('-3.5'), null);
  assert.equal(fp.parseMeasure('1,200.5'), null);
  assert.equal(fp.parseMeasure('1.2.3'), null);
  assert.equal(fp.parseMeasure('N/A'), null);
  assert.equal(fp.parseMeasure('1e3'), null);
});

test('mapPackaging1Row: real sample lines', () => {
  const cols = colsOf(fp.PKG1_LAYOUT, H1);
  const m = (l) => fp.mapPackaging1Row(fields(l), cols, tracked);
  assert.deepEqual(m(P1[0]), {
    nsn: '5340000000121', pica_sica: 'P', pkg_cat: '69Z0', unpkg_item_weight: '1.0000', unpkg_item_width: '5.000',
    unpkg_item_length: '7.500', unpkg_item_height: '1.500', ui: 'EA', tos: 'A', icq: 'AAA', mop: 'GX', clng_drying: '1',
    pres_mat: '00', wrap_mat: 'K3', cush_dun: 'NB', thk: 'A', unit_cont: 'NS', pkg_data_source: 'P',
  });
  assert.deepEqual(m(P1[1]), {
    nsn: '5340000182463', pica_sica: 'P', pkg_cat: null, unpkg_item_weight: null, unpkg_item_width: null,
    unpkg_item_length: null, unpkg_item_height: null, ui: null, tos: 'B', icq: '000', mop: '10', clng_drying: '1',
    pres_mat: '00', wrap_mat: '00', cush_dun: 'NA', thk: 'C', unit_cont: 'D3', pkg_data_source: 'P',
  });
  assert.deepEqual(m(P1[2]), { // placeholders are stored as published
    nsn: '5340000345257', pica_sica: 'P', pkg_cat: '27AZ', unpkg_item_weight: null, unpkg_item_width: null,
    unpkg_item_length: null, unpkg_item_height: null, ui: null, tos: 'A', icq: 'ZZZ', mop: 'ZZ', clng_drying: 'Z',
    pres_mat: 'ZZ', wrap_mat: 'ZZ', cush_dun: 'ZZ', thk: 'Z', unit_cont: 'ZZ', pkg_data_source: 'P',
  });
  assert.equal(m('"000000099","P","69Z0","1.0000","5.000","7.500","1.500","EA","A","AAA","GX","1","00","K3","NB","A","NS","P"'), null); // untracked
  assert.equal(m('"bad","P","69Z0","1.0000","5.000","7.500","1.500","EA","A","AAA","GX","1","00","K3","NB","A","NS","P"'), null);
  assert.equal(m('"000000121","s","","0.0000","0.000","0.000","0.000","","","","","","","","","","",""'), null); // empty row
  assert.equal(m('"000000121","s","","","","","","EA","","","","","","","","","",""').pica_sica, 'S'); // upper-cased
  assert.equal(m('"000000121","","","","","","","EA","","","","","","","","","",""').pica_sica, ''); // blank -> ''
});

test('mapPackaging2Row: real sample lines', () => {
  const cols = colsOf(fp.PKG2_LAYOUT, H2);
  const m = (l) => fp.mapPackaging2Row(fields(l), cols, tracked);
  assert.deepEqual(m(P2[0]), {
    nsn: '5340000000050', pica_sica: 'P', spc_mkg: 'ZZ', inter_cont: '00', ucl: 'A', lvl_a: null, lvl_b: null, lvl_c: null,
    unit_pack_weight: '1350.0000', up_sz_maxb: '63.30000', up_sz_maxl: '95.00000', up_sz_maxh: '47.60000',
    unit_pack_cube: '165.6490', opi: 'A', supplemental_instructions: null,
  });
  assert.deepEqual(m(P2[1]), {
    nsn: '5340000182463', pica_sica: 'P', spc_mkg: '00', inter_cont: '00', ucl: null, lvl_a: 'Q', lvl_b: 'Q', lvl_c: null,
    unit_pack_weight: '1.5000', up_sz_maxb: null, up_sz_maxl: null, up_sz_maxh: null,
    unit_pack_cube: '0.0070', opi: 'O', supplemental_instructions: 'IP056: MERCURY OR MERCURY',
  });
  assert.deepEqual(m(P2[2]), {
    nsn: '5340000000051', pica_sica: 'P', spc_mkg: '36', inter_cont: 'ZZ', ucl: null, lvl_a: 'Q', lvl_b: 'Q', lvl_c: null,
    unit_pack_weight: '0.1000', up_sz_maxb: null, up_sz_maxl: null, up_sz_maxh: null,
    unit_pack_cube: '0.0010', opi: 'M', supplemental_instructions: '------  HAZARDOUS MATERIAL',
  });
  assert.equal(m('"000000099","P","ZZ","00","A","","","","1.0","1","1","1","1","A",""'), null);
  assert.equal(m('"000000050","P","","","","","","","0.0000","0.00000","0.00000","0.00000","0.0000","",""'), null);
});

test('mapPackaging3Row: real sample lines; SPI_DATE 00000 is no date', () => {
  const cols = colsOf(fp.PKG3_LAYOUT, H3);
  const m = (l) => fp.mapPackaging3Row(fields(l), cols, tracked);
  assert.deepEqual(m(P3[0]), { nsn: '5340000000050', pica_sica: 'P', pkg_design_acty: null, spi_no: 'F004546662', spi_rev: 'D', spi_date: '89326', cont_nsn: null });
  assert.deepEqual(m(P3[1]), { nsn: '5340012079082', pica_sica: 'P', pkg_design_acty: '14153', spi_no: 'AM12529566', spi_rev: 'D', spi_date: '25267', cont_nsn: null });
  assert.deepEqual(m(P3[2]), { nsn: '5340000000051', pica_sica: 'P', pkg_design_acty: '14933', spi_no: null, spi_rev: null, spi_date: null, cont_nsn: null });
  assert.equal(m(P3_EMPTY), null); // only the '00000' placeholder: empty
});

test('mapFreightRow: real sample lines; a quoted comma in NMF_DESC survives; activity-code-only row is empty', () => {
  const cols = colsOf(fp.FREIGHT_LAYOUT, HF);
  const m = (l) => fp.mapFreightRow(fields(l), cols, tracked);
  assert.deepEqual(m(FR[0]), {
    nsn: '5340000000048', acty_cd: 'CT', nmfc: '120800', nmfc_sub: 'Z', ufc: '61410', hmc: null, ltl: 'W', lcl: 'M', rvc: '1',
    wcc: '593', tcc: 'Z', shc: '9', adc: 'A', acc: 'VZ', integ: null, nmf_desc: 'ENGINES, INTERNAL COMBUSTION, NOI',
  });
  assert.deepEqual(m(FR[1]), {
    nsn: '5340000000050', acty_cd: 'TG', nmfc: '118100', nmfc_sub: 'Z', ufc: '60340', hmc: null, ltl: 'W', lcl: null, rvc: null,
    wcc: '594', tcc: 'R', shc: 'D', adc: 'Z', acc: 'VD', integ: null, nmf_desc: 'COMPRESSORS, AIR, NOI, OR AIR ENDS',
  });
  assert.equal(m(FR[2]), null); // "9Z" only
  assert.equal(m(FR[0].replace('"000000048"', '"000000099"')), null);
});

test('mapDssRow: weight and cube; zero is not recorded; all zero is empty (header unverified)', () => {
  const cols = colsOf(fp.DSS_LAYOUT, HD);
  const m = (l) => fp.mapDssRow(fields(l), cols, tracked);
  assert.deepEqual(m('"000000050","12.5000","0.0000"'), { nsn: '5340000000050', dss_weight: '12.5000', dss_cube: null });
  assert.equal(m('"000000050","0.0000","0.0000"'), null);
  assert.equal(m('"000000099","1.0","1.0"'), null);
});

test('findFreightPackagingFiles: exact names, case-insensitive, load order', () => {
  const got = fp.findFreightPackagingFiles(['v_freight.csv', 'V_FLIS_PACKAGING_3.CSV', 'P_CAGE.CSV', 'V_FLIS_PACKAGING_1.csv', 'V_FLIS_PACKAGING_2.CSV',
    'V_FLIS_PACKAGING_4.CSV', 'V_FREIGHT_OLD.CSV', 'FREIGHT_PACKAGING.zip', 'V_DSS_WEIGHT_AND_CUBE.CSV']);
  assert.deepEqual(got, [
    { file: 'V_FLIS_PACKAGING_1.csv', kind: 'PACKAGING_1' },
    { file: 'V_FLIS_PACKAGING_2.CSV', kind: 'PACKAGING_2' },
    { file: 'V_FLIS_PACKAGING_3.CSV', kind: 'PACKAGING_3' },
    { file: 'v_freight.csv', kind: 'FREIGHT' },
    { file: 'V_DSS_WEIGHT_AND_CUBE.CSV', kind: 'DSS' },
  ]);
  assert.deepEqual(fp.findFreightPackagingFiles(['P_CAGE.CSV']), []);
});

test('checkHeader: real headers pass; a missing mapped column is refused by name; no header row is refused; unknown names reported', () => {
  assert.deepEqual(fp.checkHeader('x', fp.PKG1_LAYOUT, H1), { unknown: [] });
  assert.deepEqual(fp.checkHeader('x', fp.FREIGHT_LAYOUT, HF), { unknown: [] });
  assert.deepEqual(fp.checkHeader('x', fp.DSS_LAYOUT, HD), { unknown: [] });
  assert.deepEqual(fp.checkHeader('x', fp.PKG3_LAYOUT, H3.replace('"CONT_NSN"', '"CONT_NSN","NEW_COL"')), { unknown: ['NEW_COL'] });
  assert.throws(() => fp.checkHeader('V_FLIS_PACKAGING_2.CSV', fp.PKG2_LAYOUT, H2.replace('"UCL",', '')), /missing mapped column\(s\) UCL;/);
  assert.throws(() => fp.checkHeader('V_FREIGHT.CSV', fp.FREIGHT_LAYOUT, HF.replace('"NMFC",', '').replace('"INTEG",', '')), /missing mapped column\(s\) NMFC, INTEG;/);
  assert.throws(() => fp.checkHeader('V_FREIGHT.CSV', fp.FREIGHT_LAYOUT, FR[0]), /no header row/);
  assert.throws(() => fp.checkHeader('V_FREIGHT.CSV', fp.FREIGHT_LAYOUT, ''), /no header row/);
  // aliases and positions are not accepted
  assert.throws(() => fp.checkHeader('x', fp.DSS_LAYOUT, '"NIIN","WEIGHT","CUBE"'), /DSS_WEIGHT, DSS_CUBE/);
});

test('upsert specs: freight and DSS have no source_file_date; packaging has no static spec', async () => {
  const { buildUpsert } = await import('./load-flis.mjs');
  assert.match(buildUpsert(fp.FREIGHT_UPSERT), /ON CONFLICT \(nsn\) DO UPDATE/);
  assert.match(buildUpsert(fp.FREIGHT_UPSERT), /IS DISTINCT FROM/);
  assert.match(buildUpsert(fp.DSS_UPSERT), /INSERT INTO pub\.nsn_dss_weight_cube/);
  for (const sp of [fp.FREIGHT_UPSERT, fp.DSS_UPSERT]) assert.ok(!sp.cols.some(([n]) => n === 'source_file_date'));
  assert.equal(fp.PKG1_UPSERT, undefined);
});

test('buildPackagingWrite: merges by nsn|pica_sica, spec lists only the loaded kinds, missing keys get NULL, key counts', async () => {
  const { buildUpsert } = await import('./load-flis.mjs');
  const c1 = colsOf(fp.PKG1_LAYOUT, H1); const c2 = colsOf(fp.PKG2_LAYOUT, H2); const c3 = colsOf(fp.PKG3_LAYOUT, H3);
  const r1 = [P1[0], P1[1]].map((l) => fp.mapPackaging1Row(fields(l), c1, tracked)); // ...121, ...463
  const r2 = [P2[0], P2[1]].map((l) => fp.mapPackaging2Row(fields(l), c2, tracked)); // ...050, ...463
  const r3 = [P3[0], P3[1]].map((l) => fp.mapPackaging3Row(fields(l), c3, tracked)); // ...050, ...079082
  const all = fp.buildPackagingWrite({ PACKAGING_1: r1, PACKAGING_2: r2, PACKAGING_3: r3 });
  assert.equal(all.rows.length, 4);
  assert.deepEqual(all.keyCounts, { 1: 2, 2: 2, 3: 0 });
  assert.deepEqual(all.spec.cols.map(([n]) => n), ['nsn', 'pica_sica', ...fp.PKG1_COLUMNS, ...fp.PKG2_COLUMNS, ...fp.PKG3_COLUMNS]);
  assert.match(buildUpsert(all.spec), /ON CONFLICT \(nsn, pica_sica\) DO UPDATE/);
  const by = (n) => all.rows.find((r) => r.nsn === `5340${n}`);
  const m463 = by('000182463'); // in files 1 and 2, not 3
  assert.equal(m463.tos, 'B');
  assert.equal(m463.unit_pack_weight, '1.5000');
  assert.equal(m463.spi_no, null); // loaded file 3 does not have the key: NULL
  const m121 = by('000000121'); // file 1 only
  assert.equal(m121.pkg_cat, '69Z0');
  assert.equal(m121.opi, null);
  const m50 = by('000000050'); // files 2 and 3
  assert.equal(m50.unit_pack_weight, '1350.0000');
  assert.equal(m50.spi_no, 'F004546662');
  assert.equal(m50.pkg_cat, null);
  for (const r of all.rows) assert.deepEqual(Object.keys(r).sort(), all.spec.cols.map(([n]) => n).sort());
  // a key in all three files
  const t = { PACKAGING_1: [{ nsn: 'N', pica_sica: 'P', ...Object.fromEntries(fp.PKG1_COLUMNS.map((k) => [k, null])), ui: 'EA' }],
    PACKAGING_2: [{ nsn: 'N', pica_sica: 'P', ...Object.fromEntries(fp.PKG2_COLUMNS.map((k) => [k, null])), opi: 'A' }],
    PACKAGING_3: [{ nsn: 'N', pica_sica: 'P', ...Object.fromEntries(fp.PKG3_COLUMNS.map((k) => [k, null])), spi_no: 'X' }] };
  const three = fp.buildPackagingWrite(t);
  assert.equal(three.rows.length, 1);
  assert.deepEqual(three.keyCounts, { 1: 0, 2: 0, 3: 1 });
  assert.deepEqual([three.rows[0].ui, three.rows[0].opi, three.rows[0].spi_no], ['EA', 'A', 'X']);
  // S and P of one NIIN are two keys
  const sp = fp.buildPackagingWrite({ PACKAGING_1: [{ ...r1[0] }, { ...r1[0], pica_sica: 'S' }] });
  assert.deepEqual(sp.rows.map((r) => r.pica_sica), ['P', 'S']);
  // only the loaded kinds contribute columns; a kind that did not load is absent from the spec
  const only2 = fp.buildPackagingWrite({ PACKAGING_2: r2 });
  assert.deepEqual(only2.spec.cols.map(([n]) => n), ['nsn', 'pica_sica', ...fp.PKG2_COLUMNS]);
  assert.ok(!('pkg_cat' in only2.rows[0]));
  // a repeated key inside one file counts once for that file
  const dup = fp.buildPackagingWrite({ PACKAGING_1: [r1[0], r1[0]] });
  assert.equal(dup.rows.length, 1);
  assert.deepEqual(dup.keyCounts, { 1: 1, 2: 0, 3: 0 });
  // nothing loaded: nothing to write
  assert.deepEqual(fp.buildPackagingWrite({}), { spec: null, rows: [], keyCounts: { 1: 0, 2: 0, 3: 0 } });
});

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

const dbTest = url ? test : test.skip;
const NSNS = { a: '5340990000012', b: '5340990000024', c: '5340990000036' };
const dbTracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
const dir = mkdtempSync(path.join(tmpdir(), 'fp-'));
const crlf = (...lines) => `${lines.join('\r\n')}\r\n`;
const wr = (name, text, d = dir) => { const p = path.join(d, name); writeFileSync(p, text); return p; };

async function setup() {
  const pool = getPool();
  await pool.query(`DELETE FROM pub.nsns WHERE nsn = ANY($1)`, [Object.values(NSNS)]); // cascades to the three tables
  await pool.query(`INSERT INTO pub.fsc (fsc, name) VALUES ('5340', 'test') ON CONFLICT (fsc) DO NOTHING`);
  await pool.query(`INSERT INTO pub.nsns (nsn, fsc) SELECT x, '5340' FROM unnest($1::text[]) x`, [Object.values(NSNS)]);
}
const pk = async (nsn) => (await getPool().query(`SELECT * FROM pub.nsn_packaging WHERE nsn = $1 ORDER BY pica_sica`, [nsn])).rows;
const fr = async (nsn) => (await getPool().query(`SELECT * FROM pub.nsn_freight WHERE nsn = $1`, [nsn])).rows;
const run = (kind, file, text, extra = {}) => fp.loadFreightPackagingFile(wr(file, text), kind, dbTracked, { log: quiet, ...extra });

// Same data under the database test NIINs.
const D1 = crlf(H1, '"990000012","P","69Z0","1.0000","5.000","7.500","1.500","EA","A","AAA","GX","1","00","K3","NB","A","NS","P"',
  '"990000012","S","","0.0000","0.000","0.000","0.000","","B","000","10","1","00","00","NA","C","D3","P"',
  '"990000099","P","69Z0","1.0000","5.000","7.500","1.500","EA","A","AAA","GX","1","00","K3","NB","A","NS","P"', // untracked
  '"990000024","P","27AZ","0.0000","0.000","0.000","0.000","","A","ZZZ","ZZ","Z","ZZ","ZZ","ZZ","Z","ZZ","P"');
const D2 = crlf(H2, '"990000012","P","ZZ","00","A","","","","1350.0000","63.30000","95.00000","47.60000","165.6490","A",""',
  '"990000012","S","00","00","","Q","Q","","1.5000","0.00000","0.00000","0.00000","0.0070","O","IP056: MERCURY, OR MERCURY"');
const D3 = crlf(H3, '"990000012","P","","F004546662","D","89326",""', '"990000012","S","","","","00000",""'); // S row is empty
const DF = crlf(HF, '"990000012","CT","120800","Z","61410","","W","M","1","593","Z","9","A","VZ","","ENGINES, INTERNAL COMBUSTION, NOI"',
  '"990000024","9Z","","","","","","","","","","","","","",""',
  '"990000099","TG","118100","Z","60340","","W","","","594","R","D","Z","VD","","COMPRESSORS, AIR, NOI, OR AIR ENDS"');

// Writes the given files (name -> text) to a fresh directory and runs the whole loader on them.
async function loadAll(texts, tag = 'fp-all-') {
  const d = mkdtempSync(path.join(tmpdir(), tag));
  for (const [name, text] of Object.entries(texts)) wr(name, text, d);
  const logs = [];
  const res = await fp.loadFreightPackaging(d, fp.findFreightPackagingFiles(Object.keys(texts)), dbTracked, { log: (m) => logs.push(m) });
  rmSync(d, { recursive: true });
  return { res, logs };
}
const PK = (a, b, c) => ({ 'V_FLIS_PACKAGING_1.CSV': a, 'V_FLIS_PACKAGING_2.CSV': b, 'V_FLIS_PACKAGING_3.CSV': c });

dbTest('packaging 1, 2, 3 merge into ONE row per NSN and PICA/SICA with a single write; S and P rows are separate; idempotent', async () => {
  await setup();
  const { res, logs } = await loadAll(PK(D1, D2, D3));
  assert.equal(res.written, 3); // keys: 012/P, 012/S, 024/P, written once
  assert.ok(logs.some((l) => /merged write .*: 3 merged key\(s\) \(rows from 1 file: 1, 2 files: 1, 3 files: 1\), 3 written/.test(l)));
  assert.ok(logs.some((l) => /V_FLIS_PACKAGING_1\.CSV: \d+ rows scanned, 3 kept .*\(written once with the other packaging files\)/.test(l)));
  assert.ok(logs.some((l) => /V_FLIS_PACKAGING_3\.CSV: .*1 kept on tracked NIINs, 1 skipped as empty/.test(l)));

  const a = await pk(NSNS.a);
  assert.deepEqual(a.map((r) => r.pica_sica), ['P', 'S']); // an S row and a P row for one NIIN: two rows
  const p = a[0];
  assert.equal(p.pkg_cat, '69Z0'); // PACKAGING_1
  assert.equal(p.unpkg_item_weight, '1.0000');
  assert.equal(p.mop, 'GX');
  assert.equal(p.unit_pack_weight, '1350.0000'); // PACKAGING_2
  assert.equal(p.unit_pack_cube, '165.6490');
  assert.equal(p.ucl, 'A');
  assert.equal(p.spi_no, 'F004546662'); // PACKAGING_3
  assert.equal(p.spi_date, '89326');
  assert.ok(!('source_file_date' in p));
  const s = a[1];
  assert.equal(s.pkg_cat, null);
  assert.equal(s.unpkg_item_weight, null); // zero -> null
  assert.equal(s.supplemental_instructions, 'IP056: MERCURY, OR MERCURY');
  assert.equal(s.spi_no, null);
  const b = (await pk(NSNS.b))[0]; // only in file 1: the other files' columns are NULL
  assert.equal(b.pkg_cat, '27AZ');
  assert.equal(b.unit_pack_weight, null);
  assert.equal((await getPool().query(`SELECT count(*) FROM pub.nsn_packaging WHERE nsn = ANY($1)`, [Object.values(NSNS)])).rows[0].count, '3');
  assert.equal((await getPool().query(`SELECT count(*) FROM pub.nsn_packaging WHERE nsn = '5340990000099'`)).rows[0].count, '0');

  // second run writes nothing
  const again = await loadAll(PK(D1, D2, D3));
  assert.equal(again.res.written, 0);
  assert.ok(again.logs.some((l) => /3 merged key\(s\) .*, 0 written/.test(l)));
});

dbTest('a later run with a changed PACKAGING_2 value updates only that row; PACKAGING_1 and 3 columns stay', async () => {
  await setup();
  await loadAll(PK(D1, D2, D3));
  const before = await pk(NSNS.a);
  const { res } = await loadAll(PK(D1, D2.replace('"1350.0000"', '"1400.0000"'), D3));
  assert.equal(res.written, 1); // only the P row
  const after = await pk(NSNS.a);
  assert.equal(after[0].unit_pack_weight, '1400.0000');
  assert.ok(after[0].updated_at > before[0].updated_at);
  assert.equal(after[1].updated_at.getTime(), before[1].updated_at.getTime()); // the S row was not rewritten
  for (const k of ['pkg_cat', 'unpkg_item_weight', 'mop', 'ui', 'spi_no', 'spi_date', 'opi']) assert.deepEqual(after[0][k], before[0][k], k);
});

dbTest('PACKAGING_2 refused (missing column): its stored columns stay intact while PACKAGING_1 changes still land', async () => {
  await setup();
  await loadAll(PK(D1, D2, D3));
  const before = await pk(NSNS.a);
  const bad2 = D2.replace('"UCL",', '').replace('"1350.0000"', '"9999.0000"'); // header lacks UCL
  const { res, logs } = await loadAll(PK(D1.replace('"69Z0"', '"69Z1"'), bad2, D3));
  assert.ok(logs.some((l) => /::warning::.*V_FLIS_PACKAGING_2\.CSV load failed .*missing mapped column\(s\) UCL/.test(l)));
  assert.equal(res.written, 1);
  const after = await pk(NSNS.a);
  assert.equal(after[0].pkg_cat, '69Z1'); // file 1 change landed
  for (const k of ['unit_pack_weight', 'unit_pack_cube', 'ucl', 'opi', 'spi_no', 'spi_date']) assert.deepEqual(after[0][k], before[0][k], k); // file 2 / 3 columns untouched
  assert.equal(after[1].supplemental_instructions, 'IP056: MERCURY, OR MERCURY');
  assert.equal(after[1].updated_at.getTime(), before[1].updated_at.getTime());

  // a file that is missing altogether behaves the same
  const { logs: l2 } = await loadAll({ 'V_FLIS_PACKAGING_1.CSV': D1.replace('"69Z0"', '"69Z2"') });
  assert.ok(l2.some((l) => /::warning::.*V_FLIS_PACKAGING_2\.CSV not found/.test(l)));
  const again = await pk(NSNS.a);
  assert.equal(again[0].pkg_cat, '69Z2');
  assert.equal(again[0].unit_pack_weight, before[0].unit_pack_weight);

  // all three packaging files bad: nothing is written, freight still loads
  const hl = '"990000012","P","","F004546662","D","89326",""\r\n'; // no header row
  const r3 = await loadAll({ ...PK(hl, hl, hl), 'V_FREIGHT.CSV': DF });
  assert.ok(r3.logs.some((l) => /no packaging file loaded/.test(l)));
  assert.equal((await pk(NSNS.a))[0].pkg_cat, '69Z2');
  assert.equal((await fr(NSNS.a)).length, 1);
});

dbTest('freight: tracked rows only, activity-code-only row skipped, comma in NMF_DESC, idempotent', async () => {
  await setup();
  const r = await run('FREIGHT', 'V_FREIGHT.CSV', DF);
  assert.equal(r.kept, 1);
  assert.equal(r.empty, 1);
  assert.equal(r.written, 1);
  const f = (await fr(NSNS.a))[0];
  assert.equal(f.acty_cd, 'CT');
  assert.equal(f.nmfc, '120800');
  assert.equal(f.ufc, '61410');
  assert.equal(f.hmc, null);
  assert.equal(f.nmf_desc, 'ENGINES, INTERNAL COMBUSTION, NOI');
  assert.ok(!('source_file_date' in f));
  assert.equal((await fr(NSNS.b)).length, 0);
  assert.equal((await run('FREIGHT', 'V_FREIGHT.CSV', DF)).written, 0);
});

dbTest('dss weight and cube: loads when the file exists', async () => {
  await setup();
  const r = await run('DSS', 'V_DSS_WEIGHT_AND_CUBE.CSV', crlf(HD, '"990000012","12.5000","0.0000"', '"990000024","0.0000","0.0000"'));
  assert.equal(r.kept, 1);
  const x = (await getPool().query(`SELECT * FROM pub.nsn_dss_weight_cube WHERE nsn = $1`, [NSNS.a])).rows[0];
  assert.equal(x.dss_weight, '12.5000');
  assert.equal(x.dss_cube, null);
});

dbTest('loadFreightPackaging: bad files are warnings and the rest loads; missing DSS is a plain line; all bad throws', async () => {
  await setup();
  const d = mkdtempSync(path.join(tmpdir(), 'fp-dir-'));
  wr('V_FLIS_PACKAGING_1.CSV', D1, d);
  wr('V_FLIS_PACKAGING_2.CSV', D2.replace('"UCL",', ''), d); // missing mapped column: refused
  wr('V_FLIS_PACKAGING_3.CSV', '"990000012","P","","F004546662","D","89326",""\r\n', d); // no header row: refused
  wr('V_FREIGHT.CSV', DF, d);
  const logs = [];
  const files = fp.findFreightPackagingFiles(['V_FLIS_PACKAGING_1.CSV', 'V_FLIS_PACKAGING_2.CSV', 'V_FLIS_PACKAGING_3.CSV', 'V_FREIGHT.CSV']);
  const res = await fp.loadFreightPackaging(d, files, dbTracked, { log: (m) => logs.push(m) });
  assert.equal(res.kept, 4);
  assert.ok(logs.some((l) => /::warning::.*V_FLIS_PACKAGING_2\.CSV load failed .*missing mapped column\(s\) UCL/.test(l)));
  assert.ok(logs.some((l) => /::warning::.*V_FLIS_PACKAGING_3\.CSV load failed .*no header row/.test(l)));
  assert.ok(logs.some((l) => /^load\.mjs: V_DSS_WEIGHT_AND_CUBE\.CSV not found/.test(l))); // plain line, no ::warning::
  assert.ok(!logs.some((l) => /::warning::.*V_DSS/.test(l)));
  assert.ok(logs.some((l) => /V_FREIGHT\.CSV: \d+ rows scanned, 1 kept/.test(l)));
  assert.ok(logs.some((l) => /ACTY_CD distribution/.test(l)));
  assert.ok(logs.some((l) => /UNPKG_ITEM_WEIGHT values: \{"nonNull":1/.test(l)));
  assert.ok(logs.some((l) => /sample mapped row/.test(l)));
  assert.equal((await pk(NSNS.a))[0].pkg_cat, '69Z0');
  assert.equal((await pk(NSNS.a))[0].unit_pack_weight, null); // the refused file wrote nothing
  assert.equal((await fr(NSNS.a)).length, 1);

  // a missing one of the four main files is a warning
  const logs2 = [];
  await fp.loadFreightPackaging(d, fp.findFreightPackagingFiles(['V_FREIGHT.CSV']), dbTracked, { log: (m) => logs2.push(m) });
  assert.ok(logs2.some((l) => /::warning::.*V_FLIS_PACKAGING_1\.CSV not found/.test(l)));

  // every present file failing throws
  await assert.rejects(fp.loadFreightPackaging(d, fp.findFreightPackagingFiles(['V_FLIS_PACKAGING_2.CSV', 'V_FLIS_PACKAGING_3.CSV']), dbTracked, { log: quiet }), /./);
  rmSync(d, { recursive: true });
});

dbTest('main(): a missing zip is only a warning; present files load via load.mjs', async () => {
  await setup();
  const d = mkdtempSync(path.join(tmpdir(), 'fp-main-'));
  writeFileSync(path.join(d, 'P_FLIS_NSN.CSV'), '"FSC","NIIN","INC","ITEM_NAME","SOS","END_ITEM_NAME","CANCELLED_NIIN"\n"5340","990000012","77777","BRACKET","","",""\n');
  const runMain = () => execFileSync('node', [fileURLToPath(new URL('./load.mjs', import.meta.url)), '--dir', d], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.match(runMain(), /::warning::load\.mjs: no V_FLIS_PACKAGING_\*\.CSV \/ V_FREIGHT\.CSV .*FREIGHT_PACKAGING\.zip missing\?/);
  writeFileSync(path.join(d, 'V_FREIGHT.CSV'), DF);
  assert.match(runMain(), /freight and packaging files: \d+ kept, \d+ written/);
  assert.equal((await fr(NSNS.a)).length, 1);
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
