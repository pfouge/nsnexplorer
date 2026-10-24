// node:test suite for sam-dates.mjs against a fake SAM API. Needs a migrated scratch database
// (0013) for the ledger; runs only when TEST_DATABASE_URL is set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runSamDates, fetchSamDay, fetchSamPage, samDate, PAGE_LIMIT, KeyError, samSettled } from './sam-dates.mjs';
import { backfillCandidates, addDaysIso } from '../ledger.mjs';

test('samDate formats MM/DD/YYYY', () => assert.equal(samDate('2026-10-09'), '10/09/2026'));

// Fake SAM: `perDay(iso)` notices on each day; pages of PAGE_LIMIT by page INDEX in `offset`.
// `limit`/`remaining` simulate api.data.gov's headers; `shortOn` serves one notice fewer that day.
// `errors[iso]` is a list of HTTP statuses (or 'net' for a network failure) served, in order,
// before that day answers normally.
function fakeSam({ perDay = () => 3, limit = 1000, startRemaining = 1000, shortOn = null, requests = [], errors = {}, keyRejected = false } = {}) {
  let remaining = startRemaining;
  const queued = Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, [...v]]));
  return async (u) => {
    const url = new URL(u);
    const [m, d, y] = url.searchParams.get('postedFrom').split('/');
    const iso = `${y}-${m}-${d}`;
    const page = Number(url.searchParams.get('offset'));
    requests.push({ iso, page, limit: url.searchParams.get('limit') });
    if (keyRejected) return new Response('{"code":"900901","message":"Invalid Credentials"}', { status: 401 });
    const e = queued[iso]?.shift();
    if (e === 'net') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (e) return new Response('<html><body><h1>504 Gateway Time-out</h1></body></html>', { status: e });
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

    // Allowance spent mid-window: SAM reports 0 left, so the run stops before asking for a 429.
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    const spent = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: fakeSam({ limit: 10, startRemaining: 4 }), throttleMs: 0, load, log: () => {} });
    assert.equal(spent.quotaStop, false);
    assert.equal(spent.forward.length, 4);
    assert.deepEqual(spent.backfill, []);
    assert.equal(spent.left.length, 3 + 2); // 3 window days and 2 back-fill days wait for tomorrow

    // SAM sends no remaining-count header at all: the 429 ends the run as before.
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    let calls = 0;
    const headerless = async (u) => {
      calls += 1;
      if (calls > 4) return new Response('over', { status: 429 });
      const r = await fakeSam()(u);
      return new Response(await r.text(), { status: r.status });
    };
    const blind = await runSamDates({ pool, apiKey: 'k', now, fetchImpl: headerless, throttleMs: 0, load, log: () => {} });
    assert.equal(blind.quotaStop, true);
    assert.equal(blind.forward.length, 4);
  } finally {
    await pool.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  }
});

test('fetchSamPage: a rejected key throws KeyError at once; a 5xx or network failure is retried once', async () => {
  const quota = { limit: null, remaining: null, used: 0 };
  const requests = [];
  await assert.rejects(
    fetchSamPage({ apiKey: 'k', iso: '2026-10-18', page: 0, fetchImpl: fakeSam({ keyRejected: true, requests }), throttleMs: 0, quota }),
    (e) => e instanceof KeyError && /rejected the API key \(HTTP 401: \{"code":"900901","message":"Invalid Credentials"\}\)/.test(e.message));
  assert.equal(requests.length, 1);
  const ok = await fetchSamPage({ apiKey: 'k', iso: '2026-10-10', page: 0, fetchImpl: fakeSam({ errors: { '2026-10-10': [504] } }), throttleMs: 0, quota });
  assert.equal(ok.totalRecords, 3);
  const net = await fetchSamPage({ apiKey: 'k', iso: '2026-10-10', page: 0, fetchImpl: fakeSam({ errors: { '2026-10-10': ['net'] } }), throttleMs: 0, quota });
  assert.equal(net.totalRecords, 3);
  await assert.rejects(
    fetchSamPage({ apiKey: 'k', iso: '2026-10-10', page: 0, fetchImpl: fakeSam({ errors: { '2026-10-10': [504, 504] } }), throttleMs: 0, quota }),
    /SAM API returned 504 for 2026-10-10 page 0: 504 Gateway Time-out$/);
});

test('runSamDates: a day SAM keeps failing costs only that day; a rejected key stops the run', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const p = new pg.Pool({ connectionString: url, max: 2 });
  await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  try {
    const load = async (records) => ({ loaded: records.length, skipped: 0 });
    const now = Date.parse('2026-10-15T12:00:00Z');
    const logs = [];
    // The 2026-10-15 run: SAM answered 504 for 10-10 and the whole run ended. Now 10-10 fails alone.
    const r = await runSamDates({ pool: p, apiKey: 'k', now, fetchImpl: fakeSam({ limit: 10, startRemaining: 50, errors: { '2026-10-10': [504, 504] } }), throttleMs: 0, load, reserve: 0, log: (l) => logs.push(l) });
    assert.deepEqual(r.failed, ['2026-10-10']);
    assert.equal(r.forward.length, 6);
    assert.ok(r.forward.includes('2026-10-09'));
    assert.deepEqual(r.backfill, ['2026-10-08', '2026-10-07']);
    assert.ok(logs.some((l) => /2026-10-10 failed: SAM API returned 504/.test(l)));
    assert.match(logs.at(-1), /failed 1 \[2026-10-10\]; requests/);

    // The 2026-10-18 run: key rejected. One request, a clear message, nothing else attempted.
    const requests = [];
    const k = await runSamDates({ pool: p, apiKey: 'k', now, fetchImpl: fakeSam({ keyRejected: true, requests }), throttleMs: 0, load, log: (l) => logs.push(l) });
    assert.equal(k.keyRejected, true);
    assert.equal(requests.length, 1);
    assert.deepEqual([k.forward, k.backfill, k.failed], [[], [], []]);
    assert.match(logs.at(-1), /API KEY REJECTED/);
  } finally {
    await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    await p.end();
  }
});

// The ledger as it stood after the key was rejected: 10-08 .. 10-17 complete, each read on a later
// day except 10-17, read at 11:00 UTC on 10-17 itself; nothing for 10-18 onward.
function outageLedger() {
  const m = new Map();
  for (let d = '2026-10-08'; d <= '2026-10-17'; d = addDaysIso(d, 1)) {
    const fetched = d === '2026-10-17' ? '2026-10-17T11:00:58Z' : `${addDaysIso(d, 1)}T11:00:00Z`;
    m.set(d, { day: d, complete: true, records: 500, fetched_at: fetched });
  }
  return m;
}

test('samSettled: only a complete read made after the day ended settles it', () => {
  assert.equal(samSettled({ complete: true, fetched_at: '2026-10-17T11:00:58Z' }, '2026-10-17'), false);
  assert.equal(samSettled({ complete: true, fetched_at: '2026-10-18T04:59:00Z' }, '2026-10-17'), false); // still 10-17 in ET
  assert.equal(samSettled({ complete: true, fetched_at: '2026-10-18T06:30:00Z' }, '2026-10-17'), true);
  assert.equal(samSettled({ complete: false, fetched_at: '2026-10-20T06:30:00Z' }, '2026-10-17'), false);
});

test('after a long outage the back-fill walks every missed day, including the one read mid-day', () => {
  // Key fixed on 10-30: the 7-day window covers 10-24..10-30, the back-fill must reach back to 10-17.
  const ledger = outageLedger();
  const picked = [];
  for (let run = 0; run < 4; run += 1) {
    const { days } = backfillCandidates(ledger, { start: '2026-10-23', step: (d) => addDaysIso(d, -1), count: 2, settled: samSettled });
    picked.push(...days);
    for (const d of days) ledger.set(d, { day: d, complete: true, records: 500, fetched_at: '2026-10-31T06:30:00Z' });
  }
  assert.deepEqual(picked, ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-07']);
  // With the old rule (complete only) 10-17 would have been skipped as done.
  const old = backfillCandidates(outageLedger(), { start: '2026-10-17', step: (d) => addDaysIso(d, -1), count: 1 });
  assert.deepEqual(old.days, ['2026-10-07']);
});

test('runSamDates: the first run after the key is replaced re-reads every missed day', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const p = new pg.Pool({ connectionString: url, max: 2 });
  await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  try {
    for (const [d, row] of outageLedger()) {
      await p.query(`INSERT INTO ops.source_dates (lane, day, expected, records, complete, fetches, first_fetched_at, fetched_at)
                     VALUES ('sam', $1, 500, 500, true, 1, $2, $2)`, [d, row.fetched_at]);
    }
    const loaded = [];
    const load = async (records) => { loaded.push(records[0]?.solicitationNumber.slice(0, 10)); return { loaded: records.length, skipped: 0 }; };
    // Key replaced and pushed on 10-20 (US evening = 10-21 UTC): one run, a 10-a-day key.
    const r = await runSamDates({ pool: p, apiKey: 'k', now: Date.parse('2026-10-21T01:00:00Z'), fetchImpl: fakeSam({ limit: 10, startRemaining: 10 }), throttleMs: 0, load, reserve: 0, log: () => {} });
    assert.deepEqual(r.forward, ['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15']);
    for (const d of ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']) assert.ok(loaded.includes(d), d);
    const { rows } = await p.query(`SELECT day::text FROM ops.source_dates WHERE lane = 'sam' AND day BETWEEN '2026-10-17' AND '2026-10-21' AND complete ORDER BY day`);
    assert.equal(rows.length, 5);
  } finally {
    await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    await p.end();
  }
});

test('runSamDates: with a 10-a-day key, missed days come before refreshes (2026-10-25)', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const p = new pg.Pool({ connectionString: url, max: 2 });
  await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
  try {
    // The ledger after run #35 on 2026-10-24: 10-08..10-17 as before the outage (10-17 read only
    // that morning), 10-18..10-24 read at 19:00 UTC on 10-24 (so 10-24 itself is not settled).
    const seed = [...outageLedger()];
    for (let d = '2026-10-18'; d <= '2026-10-24'; d = addDaysIso(d, 1)) seed.push([d, { fetched_at: '2026-10-24T19:00:00Z' }]);
    for (const [d, row] of seed) {
      await p.query(`INSERT INTO ops.source_dates (lane, day, expected, records, complete, fetches, first_fetched_at, fetched_at)
                     VALUES ('sam', $1, 500, 500, true, 1, $2, $2)`, [d, row.fetched_at]);
    }
    const load = async (records) => ({ loaded: records.length, skipped: 0 });
    const order = [];
    const logs = [];
    const fetchImpl = fakeSam({ limit: 10, startRemaining: 10, requests: order });
    const r = await runSamDates({ pool: p, apiKey: 'k', now: Date.parse('2026-10-25T06:30:00Z'), fetchImpl, throttleMs: 0, load, log: (l) => logs.push(l) });
    // today, the unsettled 10-24, then the back-fill (10-17 first), then refreshes while requests last.
    assert.deepEqual(order.map((q) => q.iso), ['2026-10-25', '2026-10-24', '2026-10-17', '2026-10-07',
      '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19']);
    assert.deepEqual(r.backfill, ['2026-10-17', '2026-10-07']);
    assert.deepEqual(r.left, []);
    assert.ok(logs.some((l) => /2026-10-17 \[back-fill\] 3 of 3 notices \(complete\)/.test(l)));

    // A tighter day (6 left): the repairs still happen; only refreshes wait.
    await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    for (const [d, row] of seed) {
      await p.query(`INSERT INTO ops.source_dates (lane, day, expected, records, complete, fetches, first_fetched_at, fetched_at)
                     VALUES ('sam', $1, 500, 500, true, 1, $2, $2)`, [d, row.fetched_at]);
    }
    const tight = await runSamDates({ pool: p, apiKey: 'k', now: Date.parse('2026-10-25T06:30:00Z'), fetchImpl: fakeSam({ limit: 10, startRemaining: 6 }), throttleMs: 0, load, log: () => {} });
    assert.deepEqual(tight.backfill, ['2026-10-17', '2026-10-07']);
    assert.deepEqual(tight.left, ['2026-10-21 [refresh]', '2026-10-20 [refresh]', '2026-10-19 [refresh]']);

    // Production on 2026-10-24: SAM sent no remaining-count header. That is not "0 left": the run
    // carries on through the repairs and stops at SAM's first refusal (429), as a warning.
    await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    for (const [d, row] of seed) {
      await p.query(`INSERT INTO ops.source_dates (lane, day, expected, records, complete, fetches, first_fetched_at, fetched_at)
                     VALUES ('sam', $1, 500, 500, true, 1, $2, $2)`, [d, row.fetched_at]);
    }
    let n = 0;
    const tenThenRefuse = async (u) => {
      n += 1;
      if (n > 10) return new Response('over', { status: 429 });
      const res = await fakeSam()(u);
      return new Response(await res.text(), { status: res.status }); // no rate-limit headers at all
    };
    const blind = await runSamDates({ pool: p, apiKey: 'k', now: Date.parse('2026-10-25T06:30:00Z'), fetchImpl: tenThenRefuse, throttleMs: 0, load, log: () => {} });
    assert.deepEqual(blind.backfill, ['2026-10-17', '2026-10-07']);
    assert.equal(blind.quota.remaining, null);
    assert.equal(blind.forward.length, 7);
  } finally {
    await p.query(`DELETE FROM ops.source_dates WHERE lane = 'sam'`);
    await p.end();
  }
});
