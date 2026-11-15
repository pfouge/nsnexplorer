// node:test suite for the batched USAspending loader (load.mjs: loadRecords).
// Pure tests always run. DB tests need a migrated scratch database and run only when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://root@127.0.0.1:5432/gpx_test node --test ingest/test/usaspending-batch.test.mjs
// They load the same records once with the original per-record loadRecord and once with loadRecords and
// require identical resulting rows (surrogate ids and timestamps excluded).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { getPool, closePool } = await import('../../shared/db.mjs');
const { loadRecord, loadRecords, prepareRecord, collapseActions } = await import('../usaspending/load.mjs');
const pg = (await import('pg')).default;

const PSC = '5331';
const url = process.env.TEST_DATABASE_URL;
const skip = !url;

after(async () => {
  await closePool();
});

// ---------------------------------------------------------------- pure tests

const plan = (o) => ({ awardUid: 'A', actionDate: '2026-01-01', recipientUei: null, description: 'd', ...o });

test('collapseActions: first record wins, first non-null UEI is kept, order of first appearance preserved', () => {
  const out = collapseActions([
    plan({ awardUid: 'A', recipientUei: null, description: 'a1' }),
    plan({ awardUid: 'B', recipientUei: 'UB', description: 'b1' }),
    plan({ awardUid: 'A', recipientUei: 'U1', description: 'a2' }),
    plan({ awardUid: 'A', recipientUei: 'U2', description: 'a3' }),
    plan({ awardUid: 'B', recipientUei: 'UB2', description: 'b2' }),
  ]);
  assert.deepEqual(out.map((p) => [p.awardUid, p.description, p.recipientUei]), [
    ['A', 'a1', 'U1'],
    ['B', 'b1', 'UB'],
  ]);
});

test('collapseActions: same award on different dates are different rows; null dates never collapse', () => {
  const out = collapseActions([
    plan({ actionDate: '2026-01-01' }),
    plan({ actionDate: '2026-01-02' }),
    plan({ actionDate: null }),
    plan({ actionDate: null }),
  ]);
  assert.equal(out.length, 4);
});

test('collapseActions: does not mutate its input', () => {
  const input = [plan({ recipientUei: null }), plan({ recipientUei: 'U' })];
  collapseActions(input);
  assert.equal(input[0].recipientUei, null);
});

test('prepareRecord: throws for the records loadRecord rejects', () => {
  assert.throws(() => prepareRecord({ 'Award ID': 'x' }, PSC), /generated_internal_id/);
  assert.throws(() => prepareRecord(null, PSC), TypeError);
});

test('prepareRecord: mirrors loadRecord derivations (agency name, NSN, item name, both field spellings)', () => {
  const p = prepareRecord(
    { description: '5331999000001!WIDGET', awarding_agency: 'Top', awarding_sub_agency: 'Sub', start_date: '2026-03-04T00:00:00', amount: '12.5', recipient: 'R', recipient_uei: 'U', award_id: 'P', generated_internal_id: 'G' },
    PSC
  );
  assert.equal(p.agencyName, 'Sub');
  assert.equal(p.nsn, '5331999000001');
  assert.equal(p.itemName, 'WIDGET');
  assert.equal(p.actionDate, '2026-03-04');
  assert.equal(p.obligation, 12.5);
  assert.equal(JSON.parse(p.raw).nsn, '5331999000001');
  assert.equal(prepareRecord({ generated_internal_id: 'G', Description: 'x', 'Awarding Agency': 'Top' }, PSC).agencyName, 'Top');
  assert.equal(prepareRecord({ generated_internal_id: 'G' }, PSC).agencyName, null);
});

// ------------------------------------------------------------------ DB tests

const UID = 'TESTUB-';
const rec = (n, o = {}) => ({
  'Award ID': `T-${n}`,
  'Recipient Name': `VENDOR ${n % 5} "Q" \\ O'NEIL`,
  'Award Amount': n % 4 === 0 ? null : `${n}.25`,
  Description: n % 2 === 0 ? `5331999${String(n % 9).padStart(6, '0')}!ITEM ${n}` : `no nsn ${n}`,
  'Awarding Agency': 'TESTUB Dept',
  'Awarding Sub Agency': n % 3 === 0 ? null : `TESTUB Sub ${n % 3}`,
  'Start Date': `2026-02-${String(1 + (n % 28)).padStart(2, '0')}`,
  generated_internal_id: `${UID}${n}`,
  ...o,
});

async function cleanup(pool) {
  await pool.query(`DELETE FROM pub.contract_actions WHERE award_uid LIKE '${UID}%'`);
  await pool.query(`DELETE FROM pub.nsns WHERE nsn LIKE '5331999%'`);
  await pool.query(`DELETE FROM pub.agencies a WHERE a.name LIKE 'TESTUB %' AND NOT EXISTS (SELECT 1 FROM pub.contract_actions c WHERE c.agency_id = a.agency_id)`);
}

async function snapshot(pool) {
  const q = async (sql) => (await pool.query(sql)).rows.map((r) => r.r).sort();
  return {
    actions: await q(`SELECT (c.award_uid, c.piid, c.psc, c.naics, c.description, c.action_date, c.obligation, a.name, c.recipient_name, c.recipient_uei, c.source_url, c.raw::text)::text r
                      FROM pub.contract_actions c LEFT JOIN pub.agencies a USING (agency_id) WHERE c.award_uid LIKE '${UID}%'`),
    agencies: await q(`SELECT (toptier_code, subtier_code, name, abbreviation)::text r FROM pub.agencies WHERE name LIKE 'TESTUB %'`),
    nsns: await q(`SELECT (nsn, niin, fsc, item_name, characteristics::text, hazmat)::text r FROM pub.nsns WHERE nsn LIKE '5331999%'`),
    fsc: await q(`SELECT (fsc, name, fsg, render_depth)::text r FROM pub.fsc WHERE fsc IN ('5331')`),
  };
}

/** Runs `load` on a clean slate and returns what it left behind. */
async function outcome(pool, load) {
  await cleanup(pool);
  let counts;
  let error;
  try {
    counts = await load();
  } catch (err) {
    error = err.message;
  }
  const snap = await snapshot(pool);
  await cleanup(pool);
  return { counts, error, snap };
}

async function viaLoop(records) {
  let inserted = 0;
  let withNsn = 0;
  for (const r of records) {
    const x = await loadRecord(r, PSC);
    if (x.inserted) inserted += 1;
    if (x.nsn) withNsn += 1;
  }
  return { inserted, withNsn };
}

async function sameAsLoop(t, records, batchSize, { fallbacks = 0 } = {}) {
  const pool = getPool();
  t.after(() => cleanup(pool));
  const a = await outcome(pool, () => viaLoop(records));
  const events = [];
  const b = await outcome(pool, () => loadRecords(records, PSC, { batchSize, onFallback: (err) => events.push(err.message) }));
  // The fallback would hide a broken batch statement by redoing it row by row, so say so when it happens.
  assert.equal(events.length, fallbacks, `unexpected fallback: ${events.join('; ')}`);
  assert.deepEqual(b.counts, a.counts);
  assert.equal(b.error, a.error);
  assert.deepEqual(b.snap, a.snap);
  return { a, b };
}

// A file that mixes everything: plain rows, repeated keys with UEIs arriving late, null dates, no agency.
function mixed() {
  const out = [];
  for (let n = 1; n <= 40; n += 1) out.push(rec(n));
  out.push(rec(5, { 'Recipient UEI': 'UEI-LATE', Description: 'changed text must be ignored' })); // dup of a key in an earlier batch
  out.push(rec(60, { 'Recipient UEI': null }), rec(60, { 'Recipient UEI': 'U60A' }), rec(60, { 'Recipient UEI': 'U60B', 'Recipient Name': 'IGNORED' })); // same batch
  out.push(rec(61, { 'Recipient UEI': 'U61' }), rec(61, { 'Recipient UEI': 'OTHER' }));
  out.push(rec(70, { 'Start Date': null }), rec(70, { 'Start Date': null })); // null date: never conflicts, both kept
  out.push(rec(71, { 'Awarding Agency': null, 'Awarding Sub Agency': null }));
  out.push(rec(72, { Description: 'second record naming NSN 5331999000002!NEWER NAME' }), rec(73, { Description: '5331999000002' }));
  out.push(rec(74, { Description: '5331999000002!LAST NAME WINS' }), rec(75, { Description: '5331999000002' }));
  return out;
}

test('equivalence: fresh load (batch sizes 1, 7 and 500) leaves the same rows and counts as the per-record loader', { skip }, async (t) => {
  for (const size of [1, 7, 500]) await sameAsLoop(t, mixed(), size);
});

test('equivalence: reloading the same records inserts only the null-date rows again', { skip }, async (t) => {
  const records = mixed();
  const pool = getPool();
  t.after(() => cleanup(pool));
  const run = async (load) => {
    await cleanup(pool);
    const first = await load();
    const second = await load();
    const snap = await snapshot(pool);
    await cleanup(pool);
    return { first, second, snap };
  };
  const a = await run(() => viaLoop(records));
  const events = [];
  const b = await run(() => loadRecords(records, PSC, { batchSize: 7, onFallback: (e) => events.push(e.message) }));
  assert.deepEqual(events, []);
  assert.deepEqual(b, a);
  assert.equal(a.second.inserted, 2, 'only the two null-date records are inserted again');
});

test('equivalence: a later file fills UEIs that were missing and never overwrites one that exists', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  const first = [];
  for (let n = 1; n <= 30; n += 1) first.push(rec(n, n % 3 === 0 ? { 'Recipient UEI': `KEEP${n}` } : {}));
  const second = first.map((r, i) => ({ ...r, 'Recipient UEI': `NEW${i}` }));
  const run = async (load) => {
    await cleanup(pool);
    await load(first);
    const c = await load(second);
    const snap = await snapshot(pool);
    await cleanup(pool);
    return { c, snap };
  };
  const a = await run((r) => viaLoop(r));
  const events = [];
  const b = await run((r) => loadRecords(r, PSC, { batchSize: 8, onFallback: (e) => events.push(e.message) }));
  assert.deepEqual(events, []);
  assert.deepEqual(b, a);
  assert.equal(a.c.inserted, 0);
  assert.ok(a.snap.actions.some((r) => r.includes('KEEP3')));
  assert.ok(a.snap.actions.some((r) => r.includes('NEW0')));
  assert.ok(!a.snap.actions.some((r) => r.includes(',NEW2,')), 'record 3 already had KEEP3');
});

test('equivalence: in-batch duplicates do not raise "cannot affect row a second time" and resolve like the loop', { skip }, async (t) => {
  const records = [];
  for (let k = 0; k < 12; k += 1) {
    const seq = [[null, null, 'A'], ['X', 'Y'], [null, null], [null, 'Z']][k % 4];
    for (const u of seq) records.push(rec(100 + k, u ? { 'Recipient UEI': u } : {}));
  }
  const { a } = await sameAsLoop(t, records, 500); // all in one batch
  assert.equal(a.counts.inserted, 12);
  await sameAsLoop(t, records, 5); // groups straddle batch boundaries
});

test('equivalence: unparseable-to-record input is handled by the caller; a record with no id aborts at the same point', { skip }, async (t) => {
  const records = [];
  for (let n = 1; n <= 20; n += 1) records.push(rec(n));
  delete records[12].generated_internal_id;
  const { a, b } = await sameAsLoop(t, records, 500, { fallbacks: 1 });
  assert.match(a.error, /generated_internal_id/);
  assert.equal(a.snap.actions.length, 12, 'records before the bad one were committed, none after');
  assert.equal(b.snap.actions.length, 12);
});

test('fallback: a database error in one record rolls the batch back, loads the rows before it one by one, then fails as before', { skip }, async (t) => {
  const records = [];
  for (let n = 1; n <= 20; n += 1) records.push(rec(n));
  records[9]['Start Date'] = '2026-02-31'; // passes the date regex, rejected by Postgres
  const pool = getPool();
  t.after(() => cleanup(pool));
  const a = await outcome(pool, () => viaLoop(records));
  const events = [];
  const b = await outcome(pool, () => loadRecords(records, PSC, { batchSize: 8, onFallback: (err, n) => events.push([err.code, n]) }));
  assert.equal(b.error, a.error);
  assert.match(a.error, /out of range/);
  assert.deepEqual(b.snap, a.snap);
  assert.equal(a.snap.actions.length, 9);
  assert.deepEqual(events, [['22008', 8]], 'only the batch holding the bad row falls back; earlier batch was committed whole');
});

test('batching: statements per record collapse to a handful per batch', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const records = [];
  for (let n = 1; n <= 200; n += 1) records.push(rec(n));
  let queries = 0;
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...a) {
    queries += 1;
    return orig.apply(this, a);
  };
  try {
    const out = await loadRecords(records, PSC, { batchSize: 100 });
    assert.equal(out.inserted, 200);
  } finally {
    pg.Client.prototype.query = orig;
  }
  // per batch: BEGIN, fsc, agencies select/insert/select, fsc+nsns, upsert, COMMIT
  assert.ok(queries <= 2 * 10, `expected at most 20 statements for 2 batches, saw ${queries}`);
});

test('agencies are resolved once per distinct name across batches', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const records = [];
  for (let n = 1; n <= 30; n += 1) records.push(rec(n));
  const agencies = new Map();
  await loadRecords(records, PSC, { batchSize: 10, agencies });
  assert.deepEqual([...agencies.keys()].sort(), ['TESTUB Dept', 'TESTUB Sub 1', 'TESTUB Sub 2']);
  const n = await pool.query(`SELECT count(*)::int n FROM pub.agencies WHERE name LIKE 'TESTUB %'`);
  assert.equal(n.rows[0].n, 3);
});

test('empty input writes nothing and returns zero counts', { skip }, async () => {
  const out = await loadRecords([], PSC);
  assert.deepEqual(out, { inserted: 0, withNsn: 0 });
});
