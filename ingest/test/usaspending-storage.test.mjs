// node:test suite for the USAspending storage limits (2026-11-15): minimal raw, the history floor, and the
// cleanup of rows already stored (migration 0021's functions + db/usaspending-storage-cleanup.mjs).
// Pure tests always run. DB tests need a migrated scratch database (0021 applied) and run only when
// TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://root@127.0.0.1:5432/gpx_test node --test ingest/test/usaspending-storage.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { getPool, closePool } = await import('../../shared/db.mjs');
const { loadRecord, loadRecords, prepareRecord, minimalRaw, USASPENDING_RAW_KEYS } = await import('../usaspending/load.mjs');
const { floorFor, isBeforeFloor, effectiveFloor, HISTORY_FLOOR, NO_FLOOR_CLASSES } = await import('../usaspending/history-floor.mjs');
const { runUsaspendingMonths } = await import('../usaspending/usaspending-months.mjs');
const { runCleanup, parseArgs } = await import('../../db/usaspending-storage-cleanup.mjs');

const url = process.env.TEST_DATABASE_URL;
const skip = !url;
after(async () => {
  await closePool();
});

// A record as the fetcher stores it (field names it requests + the keys the API adds).
const UID = 'CONT_AWD_TESTUSF';
const rec = (n, o = {}) => ({
  internal_id: 900000 + n,
  'Award ID': `TESTUSF-${n}`,
  'Recipient Name': `TESTUSF VENDOR ${n % 4}`,
  'Recipient UEI': `TESTUSF${String(n % 4).padStart(5, '0')}`,
  'Award Amount': 100 + n,
  Description: `no part here, lot ${n}`,
  'Awarding Agency': 'TESTUSF Dept',
  'Awarding Sub Agency': 'TESTUSF Agency',
  'Start Date': '2024-05-15',
  generated_internal_id: `${UID}${n}_9700_-NONE-_-NONE-`,
  prime_award_recipient_id: `aaaa-${n}-C`,
  awarding_agency_id: 1234,
  agency_slug: 'testusf-agency',
  ...o,
});
const NSN = '5340998000017';

// ---------------------------------------------------------------- pure tests

test('history floor: 5330 and 5331 have none, every other class 2021-10-01', () => {
  assert.deepEqual([...NO_FLOOR_CLASSES], ['5330', '5331']);
  assert.equal(HISTORY_FLOOR, '2021-10-01');
  assert.equal(floorFor('5330'), null);
  assert.equal(floorFor('5331'), null);
  assert.equal(floorFor('5340'), '2021-10-01');
  assert.equal(floorFor(4820), '2021-10-01');
  assert.equal(isBeforeFloor('5340', '2021-09-30'), true);
  assert.equal(isBeforeFloor('5340', '2021-10-01'), false);
  assert.equal(isBeforeFloor('5340', null), false, 'an undated record is never before the floor');
  assert.equal(isBeforeFloor('5330', '2005-01-01'), false);
  assert.equal(effectiveFloor('5331', '2007-10-01'), '2007-10-01');
  assert.equal(effectiveFloor('5340', '2007-10-01'), '2021-10-01', 'a requested floor cannot go earlier than the class floor');
  assert.equal(effectiveFloor('5340', '2023-01-01'), '2023-01-01', 'but may go later');
});

test('minimalRaw / prepareRecord: only nsn (and cage when present); {} when there is nothing to keep', () => {
  assert.deepEqual([...USASPENDING_RAW_KEYS], ['nsn', 'cage']);
  assert.deepEqual(minimalRaw(rec(1), null), {});
  assert.deepEqual(minimalRaw(rec(1), NSN), { nsn: NSN });
  assert.deepEqual(minimalRaw(rec(1, { cage: '1ABC2' }), NSN), { nsn: NSN, cage: '1ABC2' });
  assert.deepEqual(minimalRaw(rec(1, { cage: '  ' }), null), {});
  const withNsn = prepareRecord(rec(2, { Description: `${NSN}!BRACKET` }), '5340');
  assert.equal(withNsn.raw, JSON.stringify({ nsn: NSN }));
  const without = prepareRecord(rec(3), '5340');
  assert.equal(without.raw, '{}');
  for (const p of [withNsn, without]) {
    for (const k of Object.keys(JSON.parse(p.raw))) assert.ok(USASPENDING_RAW_KEYS.includes(k), `unexpected raw key ${k}`);
  }
});

test('cleanup script options: defaults are small batches with interim VACUUMs; bad values are refused', () => {
  const d = parseArgs([]);
  assert.deepEqual({ dry: d.dryRun, ids: d.batchIds, vac: d.vacuum, every: d.vacuumEvery, del: d.del, slim: d.slim }, { dry: false, ids: 5000, vac: true, every: 150000, del: true, slim: true });
  const o = parseArgs(['--dry-run', '--batch-ids', '1000', '--no-vacuum', '--no-delete', '--from-id', '77']);
  assert.deepEqual({ dry: o.dryRun, ids: o.batchIds, vac: o.vacuum, del: o.del, from: o.fromId }, { dry: true, ids: 1000, vac: false, del: false, from: 77 });
  assert.throws(() => parseArgs(['--batch-ids', '5']), /batch-ids/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('loadRecords drops records before the floor of a floored class without touching the database', async () => {
  let dropped = 0;
  const out = await loadRecords([rec(1, { 'Start Date': '2020-01-01' }), rec(2, { start_date: '2021-09-30', 'Start Date': null })], '5340', { onDropped: (n) => { dropped += n; } });
  assert.deepEqual(out, { inserted: 0, withNsn: 0 });
  assert.equal(dropped, 2);
});

test('a pre-floor record that parses an NSN is not dropped by the floor filter', async () => {
  const attached = rec(1, { 'Start Date': '2020-01-01', Description: `${NSN}!BRACKET` });
  const unattached = rec(2, { 'Start Date': '2020-01-01' });
  let dropped = 0;
  // The floor filter keeps exactly the records that parse an NSN (same test loadRecords applies).
  const kept = [attached, unattached].filter((r) => {
    try { return Boolean(prepareRecord(r, '5340').nsn); } catch { return false; }
  });
  assert.deepEqual(kept, [attached]);
  const out = await loadRecords([unattached], '5340', { onDropped: (n) => { dropped += n; } });
  assert.deepEqual(out, { inserted: 0, withNsn: 0 });
  assert.equal(dropped, 1);
});

test('usaspending-months stops at the class floor and reports the lane complete', { skip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const lane = 'usaspending_9997';
  await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
  try {
    const now = Date.parse('2022-02-14T12:00:00Z'); // window (120 days) starts 2021-10-16 -> first month checked 2021-09?
    const fetched = [];
    const count = async () => 0;
    const fetchAll = async ({ startDate }) => { fetched.push(startDate); return []; };
    const logs = [];
    // 2022-02-14 minus 120 days = 2021-10-17; the month before that month = 2021-09-01, which is before the floor.
    const r = await runUsaspendingMonths({ pool, psc: '9997', months: 5, floor: '2007-10-01', now, count, fetchAll, loadMany: async () => ({ inserted: 0 }), log: (l) => logs.push(l) });
    assert.deepEqual(fetched, [], 'no month before 2021-10-01 is read for a floored class');
    assert.equal(r.complete, true);
    assert.ok(logs.some((l) => /history floor for class 9997/.test(l)), logs.join('\n'));

    // A later "now": months 2021-12 .. 2021-10 are read, then the next run is complete.
    const now2 = Date.parse('2022-06-14T12:00:00Z'); // window starts 2022-02-14 -> first month 2022-01
    const r2 = await runUsaspendingMonths({ pool, psc: '9997', months: 10, floor: '2007-10-01', now: now2, count: async () => 0, fetchAll, loadMany: async () => ({ inserted: 0 }), log: () => {} });
    assert.deepEqual(r2.months, ['2022-01-01', '2021-12-01', '2021-11-01', '2021-10-01'], 'walks back to the floor month and no further');
    assert.equal(r2.complete, false, 'this run read months, so it is not yet known to be complete');
    const r3 = await runUsaspendingMonths({ pool, psc: '9997', months: 10, floor: '2007-10-01', now: now2, count: async () => 0, fetchAll, loadMany: async () => ({ inserted: 0 }), log: () => {} });
    assert.deepEqual(r3.months, []);
    assert.equal(r3.complete, true, 'the next run has nothing to read and says so');
  } finally {
    await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
    await pool.end();
  }
});

// ------------------------------------------------------------------ DB tests

async function cleanup(pool) {
  await pool.query(`DELETE FROM pub.contract_actions WHERE award_uid LIKE '${UID}%' OR award_uid LIKE 'DIBBS-TESTUSF%'`);
  await pool.query(`DELETE FROM pub.nsns WHERE nsn IN ('${NSN}')`);
  await pool.query(`DELETE FROM pub.agencies a WHERE a.name LIKE 'TESTUSF %' AND NOT EXISTS (SELECT 1 FROM pub.contract_actions c WHERE c.agency_id = a.agency_id)`);
}
const rows = async (pool) =>
  (await pool.query(`SELECT award_uid, psc::text AS psc, action_date::text AS d, raw FROM pub.contract_actions WHERE award_uid LIKE '${UID}%' ORDER BY award_uid`)).rows;

test('a loaded USAspending row stores only allowed keys (batch path and single-record path)', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const records = [
    rec(1, { Description: `${NSN}!BRACKET,MOUNTING` }), // parsable NSN
    rec(2), // none
    rec(3, { Description: `NSN 5340-99-800-0017 KIT` }), // dashed NSN
    rec(4, { 'Start Date': null }), // no date
  ];
  await loadRecords(records.slice(0, 2), '5340', { batchSize: 1 });
  await loadRecord(records[2], '5340');
  await loadRecord(records[3], '5340');
  const got = await rows(pool);
  assert.equal(got.length, 4);
  const byN = Object.fromEntries(got.map((r) => [r.award_uid.replace(UID, '').split('_')[0], r.raw]));
  assert.deepEqual(byN['1'], { nsn: NSN });
  assert.deepEqual(byN['2'], {});
  assert.deepEqual(byN['3'], { nsn: NSN });
  assert.deepEqual(byN['4'], {});
  for (const r of got) for (const k of Object.keys(r.raw)) assert.ok(USASPENDING_RAW_KEYS.includes(k), `row ${r.award_uid} has key ${k}`);
});

test('the conflict path neither re-inflates raw nor wipes a stored nsn', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const withNsn = rec(1, { Description: `${NSN}!BRACKET` });
  await loadRecords([withNsn, rec(2)], '5340');
  // The same awards arrive again: the full API record, and a variant whose description lost the NSN.
  await loadRecords([withNsn, rec(2), { ...withNsn, Description: 'corrected text without a part number' }], '5340');
  await loadRecord(withNsn, '5340');
  await loadRecord({ ...withNsn, Description: 'again, no nsn' }, '5340');
  let got = await rows(pool);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].raw, { nsn: NSN }, 'stored nsn is kept');
  assert.deepEqual(got[1].raw, {}, 'a row stored without anything stays {}');

  // A row still holding the old full record is not rewritten by the loader either (the cleanup does that), and a
  // reload does not change it: the conflict clause touches only recipient_uei.
  await pool.query(`UPDATE pub.contract_actions SET raw = $1::jsonb WHERE award_uid LIKE '${UID}2_%'`, [JSON.stringify(rec(2))]);
  await loadRecords([rec(2)], '5340');
  got = await rows(pool);
  assert.deepEqual(got[1].raw, rec(2));
});

test('floored classes drop pre-floor records; 5330 and 5331 keep them; undated records are kept', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const set = [
    rec(1, { 'Start Date': '2021-09-30' }),
    rec(2, { 'Start Date': '2021-10-01' }),
    rec(3, { 'Start Date': null }),
    rec(4, { 'Start Date': '2015-03-02' }),
    rec(5, { 'Start Date': '2015-03-02', Description: `${NSN}!BRACKET` }), // pre-floor but part-attached: kept
  ];
  let dropped = 0;
  const a = await loadRecords(set, '5340', { onDropped: (n) => { dropped += n; } });
  assert.equal(dropped, 2);
  assert.equal(a.inserted, 3);
  assert.deepEqual((await rows(pool)).map((r) => r.award_uid.replace(UID, '').split('_')[0]), ['2', '3', '5']);
  // A reload neither re-inserts the unattached pre-floor ones nor duplicates or changes the attached one.
  // (The undated record 3 is re-inserted: the existing undated leak, unrelated to the floor.)
  const again = await loadRecords(set, '5340', { onDropped: () => {} });
  assert.equal(again.inserted, 1, 'only the undated record');
  const after = (await rows(pool)).filter((r) => r.d !== null);
  assert.deepEqual(after.map((r) => r.award_uid.replace(UID, '').split('_')[0]), ['2', '5']);
  assert.deepEqual(after[1].raw, { nsn: NSN });
  await cleanup(pool);
  dropped = 0;
  const b = await loadRecords(set, '5330', { onDropped: (n) => { dropped += n; } });
  assert.equal(dropped, 0);
  assert.equal(b.inserted, 5);
  await cleanup(pool);
  const c = await loadRecords(set, '5331');
  assert.equal(c.inserted, 5);
});

test('cleanup batch: deletes pre-floor rows of floored classes only, slims every USAspending row, never touches DIBBS', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const fat = (n, o) => rec(n, o); // the full API record, as stored before this change
  const ins = (uid, psc, date, raw, src = `https://www.usaspending.gov/award/${uid}`) =>
    pool.query(
      `INSERT INTO pub.contract_actions (award_uid, piid, psc, description, action_date, obligation, source_url, raw)
       VALUES ($1, 'P', $2, 'd', $3, 1, $4, $5::jsonb) RETURNING id`,
      [uid, psc, date, src, JSON.stringify(raw)]
    );
  const ids = [];
  for (const [uid, psc, date, raw] of [
    [`${UID}1`, '5340', '2020-06-01', fat(1)],                      // floored, old: deleted
    [`${UID}2`, '5340', '2021-10-01', { ...fat(2), nsn: NSN }],     // floored, on the floor: kept, slimmed to {nsn}
    [`${UID}3`, '5340', null, fat(3)],                              // undated: kept, slimmed
    [`${UID}4`, '5330', '2010-01-01', fat(4)],                      // no floor: kept, slimmed
    [`${UID}5`, '5331', '2010-01-01', { ...fat(5), nsn: NSN, cage: '1ABC2' }], // no floor: kept, nsn+cage kept
    [`${UID}6`, null, '2010-01-01', fat(6)],                        // no class: never deleted
    [`${UID}7`, '5340', '2020-06-01', { ...fat(7), nsn: NSN }],     // floored, old, attached: KEPT (owner decision A), slimmed to {nsn}
  ]) ids.push(Number((await ins(uid, psc, date, raw)).rows[0].id));
  const dibbsRaw = { nsn: NSN, cage: '1ABC2', awardNumber: 'SPE7M126P0001', total: '$12.00', purchaseRequest: 'PR1', solicitation: 'SPE7M1-26-T-0001', extra: 'x'.repeat(300) };
  ids.push(Number((await ins('DIBBS-TESTUSF-OLD', '5340', '2019-01-01', dibbsRaw, 'https://www.dibbs.bsm.dla.mil/x')).rows[0].id));
  // A look-alike that is not from USAspending (host differs) is never touched either.
  ids.push(Number((await ins(`${UID}8`, '5340', '2019-01-01', fat(8), 'https://example.test/award/8')).rows[0].id));

  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  const call = (...a) => pool.query(`SELECT deleted, slimmed FROM pub.usaspending_storage_cleanup_batch($1, $2, $3::date, $4::text[], $5, $6)`, a).then((r) => r.rows[0]);

  // Switches: slim off -> nothing slimmed; delete off -> nothing deleted.
  const dry = await call(lo, hi, HISTORY_FLOOR, [...NO_FLOOR_CLASSES], false, false);
  assert.deepEqual({ deleted: Number(dry.deleted), slimmed: Number(dry.slimmed) }, { deleted: 0, slimmed: 0 });

  const first = await call(lo, hi, HISTORY_FLOOR, [...NO_FLOOR_CLASSES], true, true);
  assert.equal(Number(first.deleted), 1, 'row 1 only: row 7 is old but part-attached');
  assert.equal(Number(first.slimmed), 6, 'rows 2, 3, 4, 5, 6 and 7 (row 8 has another host, DIBBS is excluded)');

  const left = Object.fromEntries((await rows(pool)).map((r) => [r.award_uid.replace(UID, '').split('_')[0], r]));
  assert.deepEqual(Object.keys(left).sort(), ['2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(left['7'].raw, { nsn: NSN }, 'a pre-floor part-attached row survives the cleanup');
  assert.deepEqual(left['2'].raw, { nsn: NSN });
  assert.deepEqual(left['3'].raw, {});
  assert.deepEqual(left['4'].raw, {});
  assert.deepEqual(left['5'].raw, { nsn: NSN, cage: '1ABC2' });
  assert.deepEqual(left['6'].raw, {});
  assert.deepEqual(left['8'].raw, fat(8), 'a non-USAspending source_url is not touched');
  const d = (await pool.query(`SELECT raw FROM pub.contract_actions WHERE award_uid = 'DIBBS-TESTUSF-OLD'`)).rows[0];
  assert.deepEqual(d.raw, dibbsRaw, 'DIBBS rows are never selected, old or not');

  // Idempotent: a second pass finds nothing.
  const second = await call(lo, hi, HISTORY_FLOOR, [...NO_FLOOR_CLASSES], true, true);
  assert.deepEqual({ deleted: Number(second.deleted), slimmed: Number(second.slimmed) }, { deleted: 0, slimmed: 0 });
});

test('cleanup driver: a dry run reports the counts and writes nothing', { skip }, async (t) => {
  const pool = getPool();
  t.after(() => cleanup(pool));
  await cleanup(pool);
  const client = await pool.connect();
  try {
    await pool.query(
      `INSERT INTO pub.contract_actions (award_uid, piid, psc, description, action_date, obligation, source_url, raw)
       VALUES ($1, 'P', '5340', 'd', '2020-01-01', 1, $2, $3::jsonb)`,
      [`${UID}9`, `https://www.usaspending.gov/award/${UID}9`, JSON.stringify(rec(9))]
    );
    const logs = [];
    const dry = await runCleanup({ client, args: { dryRun: true, batchIds: 1000, sleepMs: 0, maxMinutes: 0, fromId: 0, vacuum: false, del: true, slim: true }, log: (l) => logs.push(l) });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.toDelete >= 1);
    assert.equal((await rows(pool)).length, 1, 'dry run deleted nothing');
    assert.ok(logs.some((l) => /rows to delete/.test(l)));
  } finally {
    client.release();
  }
});
