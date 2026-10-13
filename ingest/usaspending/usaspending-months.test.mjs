// node:test suite for usaspending-months.mjs with fake API calls. Needs a migrated scratch database
// (0013) for the ledger; runs only when TEST_DATABASE_URL is set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runUsaspendingMonths, monthEnd, countAwards } from './usaspending-months.mjs';

test('monthEnd', () => {
  assert.equal(monthEnd('2026-02-01'), '2026-02-28');
  assert.equal(monthEnd('2024-02-01'), '2024-02-29');
  assert.equal(monthEnd('2025-12-01'), '2025-12-31');
});

test('countAwards reads results.contracts and sends the same filters as the fetch', async () => {
  let body;
  const n = await countAwards({ psc: '5331', startDate: '2026-01-01', endDate: '2026-01-31', fetchImpl: async (u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ results: { contracts: 42, idvs: 3 } })); } });
  assert.equal(n, 42);
  assert.deepEqual(body.filters.award_type_codes, ['A', 'B', 'C', 'D']);
  assert.deepEqual(body.filters.psc_codes, { require: [['Product', '5331']] });
  assert.deepEqual(body.filters.time_period, [{ start_date: '2026-01-01', end_date: '2026-01-31' }]);
});

const url = process.env.TEST_DATABASE_URL;
let pool;
after(async () => { if (pool) await pool.end(); });

test('walks back two months a run from before the daily window; inserts what is missing; flags short months', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  const lane = 'usaspending_9999';
  await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
  try {
    const now = Date.parse('2026-10-14T12:00:00Z'); // 120-day window starts 2026-06-16 -> first month checked is 2026-05
    const counts = { '2026-05-01': 4, '2026-04-01': 3, '2026-03-01': 2 };
    const fetched = [];
    const count = async ({ startDate, endDate }) => { assert.equal(endDate, monthEnd(startDate)); return counts[startDate] ?? 0; };
    const fetchAll = async ({ startDate }) => { fetched.push(startDate); const n = startDate === '2026-04-01' ? 2 : counts[startDate]; return Array.from({ length: n }, (_, i) => ({ i })); };
    const load = async (rec) => ({ inserted: rec.i === 0 }); // one new row per month, the rest already present
    const logs = [];
    const r = await runUsaspendingMonths({ pool, psc: '9999', now, count, fetchAll, load, log: (l) => logs.push(l) });
    assert.deepEqual(r.months, ['2026-05-01', '2026-04-01']);
    assert.deepEqual(r.incomplete, ['2026-04-01']); // 2 of 3
    assert.equal(r.inserted, 2);
    assert.ok(logs.some((l) => /2026-04 2 of 3 awards \(INCOMPLETE, will be read again\), 1 were missing/.test(l)));

    const r2 = await runUsaspendingMonths({ pool, psc: '9999', now, count, fetchAll, load, log: () => {} });
    assert.deepEqual(r2.months, ['2026-04-01', '2026-03-01']); // the short month again, then the next older one
  } finally {
    await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
  }
});
