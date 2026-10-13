// node:test suite for dibbs-dates.mjs (DIBBS grids by posting date, history ledger, back-fill).
// Pure helpers need nothing; the run tests need a migrated scratch database (0013) and run only
// when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_int node --test ingest/dibbs/dibbs-dates.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDay, dibbsDay, needsRead, withPoolRetry, runDibbsDates, SETTLE_DAYS } from './dibbs-dates.mjs';
import { DeadlineError } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('day formats, and which window dates need a read', () => {
  assert.equal(isoDay('10-09-2026'), '2026-10-09');
  assert.equal(dibbsDay('2026-10-09'), '10-09-2026');
  assert.equal(SETTLE_DAYS, 1);
  assert.equal(needsRead(undefined, '2026-10-09'), true);
  assert.equal(needsRead({ complete: false, fetched_at: '2026-10-20T00:00:00Z' }, '2026-10-09'), true); // incomplete
  assert.equal(needsRead({ complete: true, fetched_at: '2026-10-09T22:00:00Z' }, '2026-10-09'), true); // read the same day
  assert.equal(needsRead({ complete: true, fetched_at: '2026-10-10T15:00:00Z' }, '2026-10-09'), false); // read the next day
});

test('withPoolRetry waits out a full session pooler, rethrows anything else', async () => {
  let n = 0;
  const v = await withPoolRetry(async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('max clients reached in session mode'), { code: 'XX000' });
    return 'ok';
  }, { waitMs: 1, log: () => {} });
  assert.deepEqual([v, n], ['ok', 2]);
  await assert.rejects(withPoolRetry(async () => { throw new Error('deadlock detected'); }, { waitMs: 1 }), /deadlock/);
});

const url = process.env.TEST_DATABASE_URL;
let pool;
let out;
let awdPage;
let rfqPage;
before(async () => {
  awdPage = await readFile(path.join(here, 'fixtures', 'awd-grid-p1.html'), 'utf8'); // 50 rows, "Records Found: 3602"
  rfqPage = await readFile(path.join(here, 'fixtures', 'rfq-grid-p1.html'), 'utf8'); // 50 rows, "Records Found: 414"
  out = await mkdtemp(path.join(os.tmpdir(), 'dibbs-dates-'));
  if (url) {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
  }
});
after(async () => {
  await rm(out, { recursive: true, force: true });
  if (pool) await pool.end();
});

// A fake DIBBS: each date has `pages` copies of the fixture page (50 rows each). `found` overrides
// the "Records Found" number per date (default: exactly the rows served, i.e. complete).
const fakeFetch = ({ pages = 2, found = {}, fail = [], deadlineOn = null, calls = [] } = {}) => async (jar, dir, grid, date, maxPages, opts) => {
  calls.push({ date, grid, deadline: opts?.deadline });
  if (date === deadlineOn) throw new DeadlineError(date);
  if (fail.includes(date)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const base = grid === 'awd' ? awdPage : rfqPage;
  const n = found[date] ?? pages * 50;
  for (let p = 1; p <= pages; p += 1) {
    await writeFile(path.join(dir, `${grid}-${date}-p${p}.html`), base.replace(/(Records\s+Found:\s*(?:<[^>]*>\s*)*)[\d,]+/i, `$1${n}`));
  }
};
const fakeProcessors = (seen = []) => ({
  awd: async (records) => { seen.push(['awd', records.length]); return { loaded: records.length - 1, extra: 3, skipReasons: { 'unparseable NSN': 1 }, extraSkipReasons: {} }; },
  rfq: async (records, { today }) => { seen.push(['rfq', records.length, today]); return { loaded: records.length, extra: 2, skipReasons: {}, extraSkipReasons: {} }; },
});
const clean = (lane) => pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
const ledgerRows = async (lane) => (await pool.query(
  'SELECT day::text, expected, records, complete, fetches, extra FROM ops.source_dates WHERE lane = $1 ORDER BY day DESC', [lane])).rows;

test('awd: new dates, then 2 older ones; each checked against Records Found and recorded', { skip: !url }, async () => {
  await clean('dibbs_awd');
  const now = Date.parse('2026-10-14T15:00:00Z'); // Wednesday
  const logs = [];
  const seen = [];
  const calls = [];
  const r = await runDibbsDates({ pool, grid: 'awd', days: 3, backfillDays: 2, out, now, fetchDateImpl: fakeFetch({ calls }), processors: fakeProcessors(seen), log: (l) => logs.push(l) });
  assert.deepEqual(r.forward, ['10-13-2026', '10-12-2026', '10-09-2026']);
  assert.deepEqual(r.backfill, ['10-08-2026', '10-07-2026']); // older days with no ledger row: unverified, so re-read
  assert.deepEqual(calls.map((c) => c.date), [...r.forward, ...r.backfill]);
  assert.ok(calls.every((c) => Number.isFinite(c.deadline)));
  assert.deepEqual(seen.map((s) => s[1]), [100, 100, 100, 100, 100]);
  const rows = await ledgerRows('dibbs_awd');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((x) => x.complete && x.expected === 100 && x.records === 100 && x.extra === 3));
  assert.ok(logs.some((l) => /10-07-2026 \[back-fill\] 2 pages, 100 of 100 records \(complete\), 99 loaded, 3 price points \(first read\)/.test(l)));
  assert.match(logs.at(-2), /done\. loaded 5 .*incomplete 0; failed 0; left for next run 0/);
  await clean('dibbs_awd');
});

test('awd: a date short of its Records Found stays incomplete and is read again next run', { skip: !url }, async () => {
  await clean('dibbs_awd');
  const now = Date.parse('2026-10-14T15:00:00Z');
  const logs = [];
  const r1 = await runDibbsDates({ pool, grid: 'awd', days: 1, backfillDays: 1, out, now, fetchDateImpl: fakeFetch({ found: { '10-12-2026': 150 } }), processors: fakeProcessors(), log: (l) => logs.push(l) });
  assert.deepEqual(r1.backfill, ['10-12-2026']);
  assert.deepEqual(r1.incomplete, ['10-12-2026']);
  assert.ok(logs.some((l) => /10-12-2026 \[back-fill\] 2 pages, 100 of 150 records \(INCOMPLETE, will be read again\)/.test(l)));
  // Next run (pretend the forward date settled): the incomplete date comes back first.
  await pool.query(`UPDATE ops.source_dates SET fetched_at = '2026-10-20T00:00:00Z' WHERE lane = 'dibbs_awd'`);
  const r2 = await runDibbsDates({ pool, grid: 'awd', days: 1, backfillDays: 1, out, now, fetchDateImpl: fakeFetch(), processors: fakeProcessors(), log: () => {} });
  assert.deepEqual(r2.forward, []);
  assert.deepEqual(r2.backfill, ['10-12-2026']);
  assert.deepEqual(r2.incomplete, []);
  await clean('dibbs_awd');
});

test('rfq: back-fill only, starting beyond the 25 days the daily RFQ lanes re-read', { skip: !url }, async () => {
  await clean('dibbs_rfq');
  const now = Date.parse('2026-10-14T15:00:00Z');
  const seen = [];
  const r = await runDibbsDates({ pool, grid: 'rfq', days: 0, backfillDays: 2, backfillStart: 3, out, now, fetchDateImpl: fakeFetch(), processors: fakeProcessors(seen), log: () => {} });
  assert.deepEqual(r.forward, []);
  assert.deepEqual(r.backfill, ['10-09-2026', '10-08-2026']); // 3rd business day back is 10-09
  assert.deepEqual(seen, [['rfq', 100, '2026-10-14'], ['rfq', 100, '2026-10-14']]);
  assert.deepEqual((await ledgerRows('dibbs_rfq')).map((x) => [x.day, x.complete, x.extra]), [['2026-10-09', true, 2], ['2026-10-08', true, 2]]);
  await clean('dibbs_rfq');
});

test('a failed date does not stop the others; budgets end the run cleanly', { skip: !url }, async () => {
  await clean('dibbs_awd');
  const now = Date.parse('2026-10-21T15:00:00Z'); // window 10-20, 10-19, 10-16
  const r = await runDibbsDates({ pool, grid: 'awd', days: 3, backfillDays: 0, out, now, fetchDateImpl: fakeFetch({ fail: ['10-19-2026'] }), processors: fakeProcessors(), log: () => {} });
  assert.deepEqual(r.loaded, ['10-20-2026', '10-16-2026']);
  assert.deepEqual(r.failed, ['10-19-2026']);

  await clean('dibbs_awd');
  const soft = await runDibbsDates({ pool, grid: 'awd', days: 3, backfillDays: 2, out, now, startedAt: Date.now() - 60000, budgetMs: 1000, fetchDateImpl: fakeFetch(), processors: fakeProcessors(), log: () => {} });
  assert.deepEqual(soft.loaded, []);
  assert.equal(soft.left.length, 5);

  const hard = await runDibbsDates({ pool, grid: 'awd', days: 3, backfillDays: 0, out, now, fetchDateImpl: fakeFetch({ deadlineOn: '10-19-2026' }), processors: fakeProcessors(), log: () => {} });
  assert.deepEqual(hard.loaded, ['10-20-2026']);
  assert.deepEqual(hard.left, ['10-19-2026', '10-16-2026']);
  await clean('dibbs_awd');
});
