// node:test suite for sam-dates.mjs against a fake SAM API. Needs a migrated scratch database
// (0013) for the ledger; runs only when TEST_DATABASE_URL is set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runSamDates, fetchSamDay, samDate, PAGE_LIMIT } from './sam-dates.mjs';

test('samDate formats MM/DD/YYYY', () => assert.equal(samDate('2026-10-09'), '10/09/2026'));

// Fake SAM: `perDay(iso)` notices on each day; pages of PAGE_LIMIT by page INDEX in `offset`.
// `limit`/`remaining` simulate api.data.gov's headers; `shortOn` serves one notice fewer that day.
function fakeSam({ perDay = () => 3, limit = 1000, startRemaining = 1000, shortOn = null, requests = [] } = {}) {
  let remaining = startRemaining;
  return async (u) => {
    const url = new URL(u);
    const [m, d, y] = url.searchParams.get('postedFrom').split('/');
    const iso = `${y}-${m}-${d}`;
    const page = Number(url.searchParams.get('offset'));
    requests.push({ iso, page, limit: url.searchParams.get('limit') });
    remaining -= 1;
    const headers = new Headers({ 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(remaining) });
    if (remaining < 0) return new Response('over', { status: 429, headers });
    const total = perDay(iso);
    let served = Math.max(0, Math.min(PAGE_LIMIT, total - page * PAGE_LIMIT));
    if (iso === shortOn && page === 0) served -= 1;
    const opportunitiesData = Array.from({ length: served }, (_, i) => ({ solicitationNumber: `${iso}-${page}-${i}` }));
    return new Response(JSON.stringify({ totalRecords: total, opportunitiesData }), { status: 200, headers });
  };
}

test('fetchSamDay pages by page index until totalRecords is reached', async () => {
  const requests = [];
  const quota = { limit: null, remaining: null, used: 0 };
  const r = await fetchSamDay({ apiKey: 'k', iso: '2026-10-09', fetchImpl: fakeSam({ perDay: () => 2500, requests }), throttleMs: 0, quota });
  assert.equal(r.records.length, 2500);
  assert.equal(r.total, 2500);
  assert.deepEqual(requests.map((q) => q.page), [0, 1, 2]); // the old bug asked for 0 then 1000
  assert.deepEqual([quota.limit, quota.used], [1000, 3]);
});

const url = process.env.TEST_DATABASE_URL;
let pool;
after(async () => { if (pool) await pool.end(); });

test('runSamDates: window sized by the key allowance, then 2 older days, each recorded', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  try {
    const loads = [];
    const load = async (records) => { loads.push(records.length); return { loaded: records.length, skipped: 0 }; };
    const now = Date.parse('2026-10-14T12:00:00Z');
    const logs = [];

    // A 1,000-a-day key: 30 days forward, then 2 back-fill days.
    const high = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: fakeSam({ shortOn: '2026-09-13' }), throttleMs: 0, load, log: (l) => logs.push(l) });
    assert.equal(high.forward.length, 30);
    assert.equal(high.forward[0], '2026-10-14');
    assert.equal(high.forward.at(-1), '2026-09-15');
    assert.deepEqual(high.backfill, ['2026-09-14', '2026-09-13']);
    assert.deepEqual(high.incomplete, ['2026-09-13']); // served one notice fewer than SAM's count
    assert.ok(logs.some((l) => /2026-09-13 \[back-fill\] 2 of 3 notices \(INCOMPLETE, will be read again\)/.test(l)));
    assert.match(logs.at(-1), /requests used 33, remaining 967 of 1000/); // the short day asks for one more page

    // Next run: the incomplete day comes back before new older days.
    const again = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: fakeSam(), throttleMs: 0, load, backfillDays: 1, log: () => {} });
    assert.deepEqual(again.backfill, ['2026-09-13']);

    // A 10-a-day key: 7 days forward; back-fill only while more than the reserve is left.
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    const low = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: fakeSam({ limit: 10, startRemaining: 10 }), throttleMs: 0, load, reserve: 2, log: () => {} });
    assert.equal(low.forward.length, 7);
    assert.deepEqual(low.backfill, ['2026-10-07']); // 7 used, 3 left: one more, then stop at the reserve

    // Allowance spent mid-window: stops cleanly (one short retry of the 429), no back-fill.
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    const spent = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: fakeSam({ limit: 10, startRemaining: 4 }), throttleMs: 0, load, log: () => {} });
    assert.equal(spent.quotaStop, true);
    assert.equal(spent.forward.length, 4);
    assert.deepEqual(spent.backfill, []);
  } finally {
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  }
});
