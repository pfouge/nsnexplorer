// node:test suite for awards-daily.mjs (the incremental DIBBS award lane).
// pickDates/isoDay need nothing; the run tests need a migrated scratch database (0012) and run only
// when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_int node --test ingest/dibbs/awards-daily.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickDates, isoDay, runAwardsDaily, withPoolRetry, SETTLE_DAYS } from './awards-daily.mjs';
import { DeadlineError, businessDays } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('isoDay and pickDates: never-read and unsettled dates are read, settled ones skipped', () => {
  assert.equal(isoDay('10-09-2026'), '2026-10-09');
  assert.equal(SETTLE_DAYS, 2);
  const win = ['10-09-2026', '10-08-2026', '10-07-2026'];
  const state = new Map([
    ['2026-10-08', { fetched_at: '2026-10-09T15:00:00Z' }], // read the next day only: not settled
    ['2026-10-07', { fetched_at: '2026-10-09T00:00:00Z' }], // read two days after: settled
  ]);
  assert.deepEqual(pickDates(win, state), ['10-09-2026', '10-08-2026']);
});

test('withPoolRetry waits out a full session pooler, rethrows anything else', async () => {
  let n = 0;
  const logs = [];
  const v = await withPoolRetry(async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('max clients reached in session mode'), { code: 'XX000' });
    return 'ok';
  }, { waitMs: 1, log: (l) => logs.push(l) });
  assert.equal(v, 'ok');
  assert.equal(n, 2);
  assert.match(logs[0], /connection limit reached \(attempt 1 of 3\)/);
  await assert.rejects(withPoolRetry(async () => { throw new Error('deadlock detected'); }, { waitMs: 1 }), /deadlock/);
});

const url = process.env.TEST_DATABASE_URL;
let pool;
let out;
let page;
before(async () => {
  page = await readFile(path.join(here, 'fixtures', 'awd-grid-p1.html'), 'utf8');
  out = await mkdtemp(path.join(os.tmpdir(), 'awd-daily-'));
  if (url) {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
  }
});
after(async () => {
  await rm(out, { recursive: true, force: true });
  if (pool) await pool.end();
});

// A fake DIBBS: every date has `pages` copies of the fixture grid page; `fail` dates throw.
const fakeFetch = ({ pages = 2, fail = [], deadlineOn = null, calls = [] } = {}) => async (jar, dir, type, date, maxPages, opts) => {
  calls.push({ date, deadline: opts?.deadline });
  if (date === deadlineOn) throw new DeadlineError(date);
  if (fail.includes(date)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  for (let p = 1; p <= pages; p += 1) await writeFile(path.join(dir, `awd-${date}-p${p}.html`), page);
};
const fakeLoads = (seen = []) => ({
  loadActions: async (records) => { seen.push(records.length); return { loaded: records.length - 1, skipped: [{ reason: 'unparseable NSN' }] }; },
  loadPrices: async (records) => ({ loaded: 3, skipReasons: { 'no solicitation number or non-positive total': records.length - 3 } }),
});

test('runAwardsDaily: loads each date as it is fetched, records it, and skips settled dates next time', { skip: !url }, async () => {
  const now = Date.parse('2026-10-14T15:00:00Z'); // Wednesday
  const win = businessDays(3, now); // 10-13, 10-12, 10-09
  await pool.query('DELETE FROM ops.dibbs_award_dates WHERE day = ANY($1::date[])', [win.map(isoDay).concat(['2026-10-08'])]);
  const logs = [];
  const seen = [];
  const calls = [];
  const r1 = await runAwardsDaily({ pool, days: 3, out, now, fetchDateImpl: fakeFetch({ calls }), ...fakeLoads(seen), log: (l) => logs.push(l) });
  assert.deepEqual(r1.loaded, win);
  assert.deepEqual(seen, [100, 100, 100]); // 2 fixture pages x 50 records, per date
  assert.ok(calls.every((c) => Number.isFinite(c.deadline)));
  const { rows } = await pool.query('SELECT day::text, pages, records, loaded, price_points, fetches FROM ops.dibbs_award_dates WHERE day = ANY($1::date[]) ORDER BY day', [win.map(isoDay)]);
  assert.deepEqual(rows.map((x) => [x.day, x.pages, x.records, x.loaded, x.price_points, x.fetches]), [
    ['2026-10-09', 2, 100, 99, 3, 1], ['2026-10-12', 2, 100, 99, 3, 1], ['2026-10-13', 2, 100, 99, 3, 1]]);
  assert.match(logs.at(-2), /done\. loaded 3 .* failed 0; left for next run 0/);
  assert.match(logs.at(-1), /"unparseable NSN":3/);

  // Pretend those reads happened on the dates' own days + 0, + 1 and + 5: only 10-09 is settled.
  await pool.query(`UPDATE ops.dibbs_award_dates SET fetched_at = CASE day
    WHEN '2026-10-13' THEN '2026-10-13T20:00:00Z' WHEN '2026-10-12' THEN '2026-10-13T20:00:00Z' ELSE '2026-10-14T09:00:00Z' END::timestamptz
    WHERE day = ANY($1::date[])`, [win.map(isoDay)]);
  const logs2 = [];
  const r2 = await runAwardsDaily({ pool, days: 3, out, now, fetchDateImpl: fakeFetch({ pages: 3 }), ...fakeLoads(), log: (l) => logs2.push(l) });
  assert.deepEqual(r2.loaded, ['10-13-2026', '10-12-2026']);
  assert.deepEqual(r2.settled, ['10-09-2026']);
  assert.ok(logs2.some((l) => /10-13-2026 3 pages, 150 records, .*re-read 2, records changed from 100/.test(l)));
  const changed = await pool.query(`SELECT records_changed, fetches FROM ops.dibbs_award_dates WHERE day = '2026-10-13'`);
  assert.deepEqual(changed.rows[0], { records_changed: true, fetches: 2 });
});

test('runAwardsDaily: a failed date does not stop the others; budgets end the run cleanly', { skip: !url }, async () => {
  const now = Date.parse('2026-10-21T15:00:00Z');
  const win = businessDays(3, now); // 10-20, 10-19, 10-16
  await pool.query('DELETE FROM ops.dibbs_award_dates WHERE day = ANY($1::date[])', [win.map(isoDay)]);

  const r = await runAwardsDaily({ pool, days: 3, out, now, fetchDateImpl: fakeFetch({ fail: ['10-19-2026'] }), ...fakeLoads(), log: () => {} });
  assert.deepEqual(r.loaded, ['10-20-2026', '10-16-2026']);
  assert.deepEqual(r.failed, ['10-19-2026']);

  // The retry job a moment later (reads stamped at "now", so 10-16 is settled; 10-20 is not yet):
  // the failed date is read, and nothing that is settled.
  await pool.query(`UPDATE ops.dibbs_award_dates SET fetched_at = '2026-10-21T15:00:00Z' WHERE day = ANY($1::date[])`, [win.map(isoDay)]);
  const calls = [];
  const r2 = await runAwardsDaily({ pool, days: 3, out, now, fetchDateImpl: fakeFetch({ calls }), ...fakeLoads(), log: () => {} });
  assert.deepEqual(calls.map((c) => c.date), ['10-20-2026', '10-19-2026']);
  assert.deepEqual(r2.loaded, ['10-20-2026', '10-19-2026']);
  assert.deepEqual(r2.settled, ['10-16-2026']);

  // Soft budget already spent: nothing new is started.
  await pool.query('DELETE FROM ops.dibbs_award_dates WHERE day = ANY($1::date[])', [win.map(isoDay)]);
  const soft = await runAwardsDaily({ pool, days: 3, out, now, startedAt: Date.now() - 60000, budgetMs: 1000, fetchDateImpl: fakeFetch(), ...fakeLoads(), log: () => {} });
  assert.deepEqual(soft.loaded, []);
  assert.deepEqual(soft.left, win);

  // Hard limit during the second date: the first is kept, the rest left for the next run.
  const hard = await runAwardsDaily({ pool, days: 3, out, now, fetchDateImpl: fakeFetch({ deadlineOn: '10-19-2026' }), ...fakeLoads(), log: () => {} });
  assert.deepEqual(hard.loaded, ['10-20-2026']);
  assert.deepEqual(hard.left, ['10-19-2026', '10-16-2026']);
  assert.deepEqual(hard.failed, []);
  await pool.query('DELETE FROM ops.dibbs_award_dates WHERE day = ANY($1::date[])', [win.map(isoDay)]);
});
