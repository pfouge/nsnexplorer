// ingest/publog/load-flis.test.mjs
// Tests for load-flis.mjs. The pure-function tests always run. The database tests need a migrated
// scratch database (migration 0014 applied) and are skipped unless TEST_DATABASE_URL is set,
// like ingest/test/loaders.db.test.mjs:
//
//   TEST_DATABASE_URL=postgresql://root@127.0.0.1:5432/gpx_flis node --test ingest/publog/load-flis.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const flis = await import('./load-flis.mjs');
const { getPool, closePool } = await import('../../shared/db.mjs');
const { loadMoeRule, buildTrackedNiinMap } = await import('./load.mjs');

const quiet = () => {};
const NOW = new Date('2026-11-14T00:00:00Z');

// ---------------------------------------------------------------------------
// pure
// ---------------------------------------------------------------------------

test('parseFlisDate: DD-MON-YY, DD-MON-YYYY, ISO, junk', () => {
  assert.equal(flis.parseFlisDate('10-JAN-22', NOW), '2022-01-10');
  assert.equal(flis.parseFlisDate('02-JUL-2026', NOW), '2026-07-02');
  assert.equal(flis.parseFlisDate('15-jun-63', NOW), '1963-06-15');
  assert.equal(flis.parseFlisDate('01-MAR-27', NOW), '2027-03-01'); // within a year ahead
  assert.equal(flis.parseFlisDate('01-MAR-28', NOW), '1928-03-01'); // beyond cutoff: 19yy
  assert.equal(flis.parseFlisDate('2024-02-29', NOW), '2024-02-29');
  assert.equal(flis.parseFlisDate('', NOW), null);
  assert.equal(flis.parseFlisDate('31-FEB-2020', NOW), null);
  assert.equal(flis.parseFlisDate('10-XXX-22', NOW), null);
  assert.equal(flis.parseFlisDate('garbage', NOW), null);
});

test('resolveColumns: header names, positional fallback, headerless file', () => {
  const withHeader = flis.resolveColumns(flis.CANCEL_LAYOUT, ['NIIN', 'CANCELLED_NIIN_FSC', 'CANCELLED_NIIN', 'NIIN_STAT_CD', 'EFF_DATE', 'DEMIL'], 'niin');
  assert.equal(withHeader.hasHeader, true);
  assert.equal(withHeader.cols.demil, 5);
  // header present but reordered / one name missing -> by name, then position
  const odd = flis.resolveColumns(flis.CANCEL_LAYOUT, ['EFF_DATE', 'NIIN', 'CANCELLED_NIIN', 'X', 'Y', 'Z'], 'niin');
  assert.equal(odd.cols.eff_date, 0);
  assert.equal(odd.cols.niin, 1);
  assert.equal(odd.via.cancelled_niin_fsc, 'position');
  const none = flis.resolveColumns(flis.CANCEL_LAYOUT, ['000000051', '5960', '001649799', '5', '02-JUL-2026', 'A'], 'niin');
  assert.equal(none.hasHeader, false);
  assert.equal(none.cols.eff_date, 4);
});

test('mappers: tracked vs untracked, blank rows, bad rows', () => {
  const tracked = new Map([['000000012', '4935000000012'], ['001649799', '5960001649799']]);
  const idCols = flis.resolveColumns(flis.IDENT_LAYOUT, [], 'niin').cols;
  assert.equal(flis.mapFlisIdentificationRow(['000000099', '77777'], idCols, tracked, null), null);
  assert.equal(flis.mapFlisIdentificationRow(['000000012'], idCols, tracked, null), null); // key only
  assert.equal(flis.mapFlisIdentificationRow([], idCols, tracked, null), null);
  const row = flis.mapFlisIdentificationRow(
    ['000000012', '77777', '2146085', '', '0', 'B', '3', '10-JAN-22', 'U', '', 'N', '', '', '', '', '', 'N32', ''], idCols, tracked, '2026-10-23');
  assert.equal(row.nsn, '4935000000012');
  assert.equal(row.demil, 'B');
  assert.equal(row.crit_cd, null);
  assert.equal(row.niin_assigned, '2022-01-10');
  assert.equal(row.last_known_sos, 'N32');

  const cc = flis.resolveColumns(flis.CANCEL_LAYOUT, [], 'niin').cols;
  // tracked on the CANCELLED_NIIN side only
  const c = flis.mapCancellationRow(['000000051', '5960', '001649799', '5', '02-JUL-2026', 'A'], cc, tracked);
  assert.equal(c.nsn, '5960001649799');
  assert.equal(c.eff_date, '2026-07-02');
  assert.equal(flis.mapCancellationRow(['000000051', '5960', '000000777', '5', '', 'A'], cc, tracked), null);
  assert.equal(flis.mapCancellationRow(['bad', '5960', '001649799'], cc, tracked), null);

  const sc = flis.resolveColumns(flis.STDZN_LAYOUT, [], 'niin').cols;
  assert.equal(flis.mapStandardizationRow(['000000012', '', '', '', '', '4'], sc, tracked), null); // status only
  const s = flis.mapStandardizationRow(['000000012', '4935-00-000-0013', 'AB', 'X', '05-MAY-19', '3'], sc, tracked);
  assert.equal(s.related_nsn, '4935000000013');
  assert.equal(s.stdzn_date, '2019-05-05');
});

test('buildUpsert: multi-row unnest upsert that skips unchanged rows', () => {
  const sql = flis.buildUpsert(flis.UPSERT_SPECS.moe);
  assert.match(sql, /INSERT INTO pub\.moe_rules/);
  assert.match(sql, /ON CONFLICT \(nsn, moe_rl\) DO UPDATE/);
  assert.match(sql, /IS DISTINCT FROM/);
});

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

const dbTest = url ? test : test.skip;

const NSNS = { a: '5340990000012', b: '5340990000024', c: '5340990000036' };
const dir = mkdtempSync(path.join(tmpdir(), 'flis-'));
const wr = (name, text) => { const p = path.join(dir, name); writeFileSync(p, text); return p; };

const FILES = {
  ident:
    '"NIIN","INC","PINC","CRIT_CD","II","DMIL","DMIL_INT_CD","NIIN_ASGMT","PMIC","ADP","HMIC","ESD_EMI","HCC","SCHEDULE_B","ENAC","IUID_INDICATOR","LST_KWN_SOS","FEDMALL"\n' +
    '"990000012","77777","2146085","C","0","B","3","10-JAN-22","U","","N","","","","","","N32",""\n' +
    '"990000024","12345","","","0","A","1","03-MAR-1988","","","","","","","","","",""\n' +
    '\n' +
    '"990000099","99999","","","0","D","1","03-MAR-1988","","","","","","","","","",""\n' + // untracked
    '"990000036"\n' + // key only
    '"short"\n',
  stdzn:
    '"NIIN","RELATED_NSN","ISC","ORIG_STDZN_DEC","DT_STDZN_DEC","NIIN_STAT_CD"\n' +
    '"990000012","","","","","4"\n' +
    '"990000012","5340990000024","B","S","05-MAY-19","3"\n' +
    '"990000012","5340990000036","","","","3"\n' +
    '"990000099","5340990000024","B","S","05-MAY-19","3"\n',
  cancel:
    '"NIIN","CANCELLED_NIIN_FSC","CANCELLED_NIIN","NIIN_STAT_CD","EFF_DATE","DEMIL"\n' +
    '"990000012","5340","990000777","5","02-JUL-2026","A"\n' +
    '"990000555","5340","990000024","3","15-JUN-97","D"\n' +
    '"990000555","5340","990000666","3","15-JUN-97","D"\n' +
    '"990000555","5340","bad","3","15-JUN-97","D"\n',
  moe:
    '"NIIN","MOE_RL","MOE_CD","AMC","AMSC","NIMSC","DT_ASGND","IMC","IMCA","AAC","PICA","PICA_LOA","SICA","SICA_LOA","AUTH_COLLAB","SUPP_COLLAB","DSOR","FMR_MOE_RL","ROW_OBS_DT"\n' +
    '"990000012","DS01","DS","1","G","","01-MAR-06","","","J","DS","81","","","","","","",""\n' +
    '"990000012","ZK01","ZK","","","","01-MAR-06","","","ZK","81","","","","","","D","",""\n' +
    '"990000099","DS01","DS","1","G","","01-MAR-06","","","J","DS","81","","","","","","",""\n' +
    '"990000024","","DS","1","G","","","","","","","","","","","","","",""\n', // no rule number: skipped
  help:
    '"CODE","LITERAL","DESCRIPTION","REGS"\n' +
    '"AAC","ACQUISITION ADVICE","ACQUISITION ADVICE CODE (AAC):  A CODE, DENOTING HOW","HTTPS://WWW.DLA.MIL/X.DOCX"\n' +
    '"DEMIL","DEMILITARIZATION","FIRST LINE\nSECOND LINE WITH ""QUOTE""","HTTPS://WWW.DLA.MIL/Y"\n' +
    '"AAC","ACQUISITION ADVICE","SECOND DEFINITION","HTTPS://WWW.DLA.MIL/X.DOCX"\n',
  colloq:
    '"INC","COLLOQUIAL_NAME"\n"00001","KENOTRON,RECTIFIER"\n"00001","RECTIFIER TUBE"\n"00001","RECTIFIER TUBE"\n"00002",""\n',
};

async function setup() {
  const pool = getPool();
  for (const t of ['pub.amsc_observations', 'pub.part_numbers', 'pub.nsns']) {
    await pool.query(`DELETE FROM ${t} WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
  }
  await pool.query(`INSERT INTO pub.fsc (fsc, name) VALUES ('5340', 'test') ON CONFLICT (fsc) DO NOTHING`);
  await pool.query(`INSERT INTO pub.nsns (nsn, fsc) SELECT x, '5340' FROM unnest($1::text[]) x`, [Object.values(NSNS)]);
}
const count = async (t, where = 'true') => Number((await getPool().query(`SELECT count(*) FROM ${t} WHERE ${where}`)).rows[0].count);

dbTest('loaders: tracked only, parsing, idempotent second run', async () => {
  await setup();
  const tracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
  const p = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, wr(`${k}.csv`, v)]));

  const r1 = await flis.loadFlisIdentification(p.ident, tracked, { log: quiet, sourceFileDate: '2026-10-23' });
  assert.deepEqual(r1, { scanned: 5, kept: 2, written: 2 });
  const id = (await getPool().query(`SELECT * FROM pub.nsn_identification WHERE nsn = $1`, [NSNS.a])).rows[0];
  assert.equal(id.demil, 'B');
  assert.equal(id.crit_cd, 'C');
  assert.equal(id.niin_assigned.toISOString().slice(0, 10), '2022-01-10');
  assert.equal(id.source_file_date.toISOString().slice(0, 10), '2026-10-23');
  assert.equal(await count('pub.nsn_identification', `nsn = '${NSNS.c}'`), 0);

  const r2 = await flis.loadStandardization(p.stdzn, tracked, { log: quiet });
  assert.deepEqual(r2, { scanned: 4, kept: 2, written: 2 });

  const r3 = await flis.loadCancelledNiin(p.cancel, tracked, { log: quiet });
  assert.equal(r3.kept, 2); // niin-side tracked + cancelled-side tracked; unrelated and malformed skipped
  const cr = (await getPool().query(`SELECT niin, cancelled_niin, nsn, eff_date FROM pub.nsn_cancellations ORDER BY niin`)).rows;
  assert.equal(cr.find((r) => r.niin === '990000555' && r.cancelled_niin === '990000024').nsn, NSNS.b);
  assert.equal(cr.find((r) => r.niin === '990000012').nsn, NSNS.a);
  assert.equal(cr.find((r) => r.niin === '990000555').eff_date.toISOString().slice(0, 10), '1997-06-15');

  const r4 = await flis.loadMoeRulesAll(p.moe, tracked, { log: quiet });
  assert.deepEqual({ k: r4.kept, w: r4.written }, { k: 2, w: 2 });

  const r5 = await flis.loadFlisCodes(p.help, { log: quiet });
  assert.equal(r5.kept, 3);
  assert.equal(await count('pub.flis_codes', `code IN ('AAC','DEMIL')`), 2);
  assert.match((await getPool().query(`SELECT description FROM pub.flis_codes WHERE code='DEMIL'`)).rows[0].description, /FIRST LINE\nSECOND LINE WITH "QUOTE"/);
  assert.equal((await getPool().query(`SELECT description FROM pub.flis_codes WHERE code='AAC'`)).rows[0].description, 'SECOND DEFINITION');

  const r6 = await flis.loadColloquialNames(p.colloq, { log: quiet });
  assert.equal(r6.kept, 3);
  assert.equal(await count('pub.inc_colloquial_names', `inc IN ('00001','00002')`), 2);

  // second run: identical data, nothing rewritten, same row counts
  const before = await count('pub.nsn_identification', `nsn = ANY('{${Object.values(NSNS)}}')`);
  const again = [
    await flis.loadFlisIdentification(p.ident, tracked, { log: quiet, sourceFileDate: '2026-10-23' }),
    await flis.loadStandardization(p.stdzn, tracked, { log: quiet }),
    await flis.loadCancelledNiin(p.cancel, tracked, { log: quiet }),
    await flis.loadMoeRulesAll(p.moe, tracked, { log: quiet }),
    await flis.loadFlisCodes(p.help, { log: quiet }),
    await flis.loadColloquialNames(p.colloq, { log: quiet }),
  ];
  assert.deepEqual(again.map((r) => r.written), [0, 0, 0, 0, 0, 0]);
  assert.equal(await count('pub.nsn_identification', `nsn = ANY('{${Object.values(NSNS)}}')`), before);

  // changed source value updates in place; a row missing from the source is left alone
  const changed = wr('ident2.csv', FILES.ident.replace('"B","3"', '"C","3"').replace(/"990000024".*\n/, ''));
  const r7 = await flis.loadFlisIdentification(changed, tracked, { log: quiet, sourceFileDate: '2026-10-23' });
  assert.equal(r7.written, 1);
  assert.equal((await getPool().query(`SELECT demil FROM pub.nsn_identification WHERE nsn=$1`, [NSNS.a])).rows[0].demil, 'C');
  assert.equal(await count('pub.nsn_identification', `nsn = '${NSNS.b}'`), 1);
});

dbTest('loaders: headerless identification file and malformed rows do not throw', async () => {
  await setup();
  const tracked = new Map(Object.values(NSNS).map((n) => [n.slice(4), n]));
  const f = wr('ident-nohdr.csv',
    '"990000012","77777","2146085","","0","B","3","10-JAN-22","U","","N","","","","","","N32",""\n' +
    '"990000024","12345","","","0","A","1","not-a-date","","","","","","","","","",""\n' +
    '"990000036","unterminated,"x\n');
  const r = await flis.loadFlisIdentification(f, tracked, { log: quiet });
  assert.equal(r.scanned, 3);
  assert.ok(r.kept >= 2);
  const row = (await getPool().query(`SELECT demil, niin_assigned FROM pub.nsn_identification WHERE nsn=$1`, [NSNS.b])).rows[0];
  assert.equal(row.demil, 'A');
  assert.equal(row.niin_assigned, null);
});

dbTest('loaders: a missing file rejects (main turns it into a warning)', async () => {
  await assert.rejects(flis.loadFlisCodes(path.join(dir, 'nope.csv'), { log: quiet }));
});

dbTest('single pass: loadMoeRule + createMoeRulesAllLoader read V_MOE_RULE.CSV once', async () => {
  await setup();
  const tracked = await buildTrackedNiinMap();
  const f = wr('V_MOE_RULE.CSV', FILES.moe);
  const all = flis.createMoeRulesAllLoader(tracked, { log: quiet });
  const res = await loadMoeRule(f, tracked, { log: quiet, tap: all.tap });
  const out = await all.finish({ scanned: res.scanned });
  assert.equal(out.kept, 2);
  assert.equal(await count('pub.moe_rules', `nsn = '${NSNS.a}'`), 2);
  assert.equal(res.kept, 2); // pub.amsc_observations is unchanged: one best AMC/AMSC row per NSN with a code (990000012 DS, 990000024)
  await getPool().query(`DELETE FROM pub.amsc_observations WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
});

dbTest('main(): runs end to end on a fixture directory; a missing file is only a warning', async () => {
  await setup();
  const d = mkdtempSync(path.join(tmpdir(), 'flis-main-'));
  const w = (n, t) => writeFileSync(path.join(d, n), t);
  w('P_FLIS_NSN.CSV', '"FSC","NIIN","INC","ITEM_NAME","SOS","END_ITEM_NAME","CANCELLED_NIIN"\n"5340","990000012","77777","BRACKET","","",""\n');
  w('V_FLIS_PART.CSV', '"NIIN","PART_NUMBER","CAGE_CODE","CAGE_STATUS","RNCC","RNVC","DAC","RNAAC","RNFC","RNSC","RNJC","SADC","HCC","MSDS","MEDALS"\n"990000012","AB-1","1ABC2","A","3","2","6","9Z","4","A","","","","",""\n');
  w('P_CAGE.CSV', '"CAGE_CODE","CAGE_STATUS","TYPE","CAO","COMPANY","CITY","STATE_PROVINCE","ZIP_POSTAL_ZONE","COUNTRY"\n"1ABC2","A","","","ACME","TOWN","OH","44444","UNITED STATES"\n');
  w('V_MOE_RULE.CSV', FILES.moe);
  w('V_FLIS_IDENTIFICATION.CSV', FILES.ident);
  w('V_FLIS_STANDARDIZATION.CSV', FILES.stdzn);
  w('V_FLIS_CANCELLED_NIIN.CSV', FILES.cancel);
  w('P_HELP.CSV', FILES.help);
  // V_COLLOQUIAL_NAME.CSV deliberately absent
  const out = execFileSync('node', [fileURLToPath(new URL('./load.mjs', import.meta.url)), '--dir', d],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  assert.match(out, /::warning::load\.mjs: V_COLLOQUIAL_NAME\.CSV not found/);
  assert.match(out, /V_FLIS_IDENTIFICATION\.CSV DEMIL distribution: B:1 A:1|DEMIL distribution: A:1 B:1/);
  assert.equal(await count('pub.nsn_identification', `nsn = ANY('{${Object.values(NSNS)}}')`), 2);
  assert.equal(await count('pub.moe_rules', `nsn = '${NSNS.a}'`), 2);
  assert.equal(await count('pub.flis_codes', `code = 'DEMIL'`), 1);
  console.log(out);
  rmSync(d, { recursive: true });
});

test.after(async () => {
  if (url) {
    await getPool().query(`DELETE FROM pub.amsc_observations WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
    await getPool().query(`DELETE FROM pub.part_numbers WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
    await getPool().query(`DELETE FROM pub.nsns WHERE nsn = ANY($1)`, [Object.values(NSNS)]);
    await getPool().query(`DELETE FROM pub.nsn_cancellations WHERE niin LIKE '9900000%'`);
    await getPool().query(`DELETE FROM pub.flis_codes WHERE code IN ('AAC','DEMIL') AND description IN ('SECOND DEFINITION') OR code='DEMIL'`);
    await getPool().query(`DELETE FROM pub.inc_colloquial_names WHERE inc IN ('00001','00002')`);
  }
  await closePool();
  rmSync(dir, { recursive: true, force: true });
});
