// node:test suite for rejoin.mjs: stored DIBBS award rows are re-priced from the database.
// Needs a migrated scratch database; runs only when TEST_DATABASE_URL is set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rejoinForSolicitations, rejoinRecent } from './rejoin.mjs';

const url = process.env.TEST_DATABASE_URL;
let pool;
after(async () => { if (pool) await pool.end(); });

test('stored awards are found by solicitation number in any spelling, and by award date', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  const uids = ['DIBBS-TESTREJOIN-1', 'DIBBS-TESTREJOIN-2', 'USA-TESTREJOIN-3'];
  const clean = () => pool.query('DELETE FROM pub.contract_actions WHERE award_uid = ANY($1)', [uids]);
  await clean();
  try {
    const ins = (uid, date, raw) => pool.query(
      `INSERT INTO pub.contract_actions (award_uid, action_date, source_url, raw) VALUES ($1, $2, 'https://example.test/', $3)`,
      [uid, date, raw]);
    await ins(uids[0], '2026-09-01', { solicitation: 'SPE7L126T966Q', total: 100, awardNumber: 'A1' });
    await ins(uids[1], '2020-01-01', { solicitation: 'SPE4A5-20-Q-0001', total: 5, awardNumber: 'A2' });
    await ins(uids[2], '2026-09-01', { solicitation: 'SPE7L126T966Q' }); // not a DIBBS row: never re-joined here

    const seen = [];
    const loadPrices = async (records) => { seen.push(records.map((r) => r.awardNumber)); return { matched: records.length, loaded: records.length, skipped: 0, skipReasons: {} }; };

    const a = await rejoinForSolicitations(pool, ['SPE7L1-26-T-966Q --', null], { loadPrices });
    assert.equal(a.awards, 1);
    assert.deepEqual(seen.pop(), ['A1']);

    const none = await rejoinForSolicitations(pool, [], { loadPrices });
    assert.equal(none.awards, 0);

    const recent = await rejoinRecent(pool, { days: 3650, loadPrices });
    assert.ok(seen.pop().includes('A1'));
    assert.ok(recent.awards >= 1);
    const all = await rejoinRecent(pool, { loadPrices });
    const allSeen = seen.pop();
    assert.ok(allSeen.includes('A1') && allSeen.includes('A2'));
    assert.ok(all.awards >= 2);
  } finally {
    await clean();
  }
});
