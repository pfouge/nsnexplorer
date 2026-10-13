// node:test suite for ingest/ledger.mjs. The walk and date helpers need nothing; recordPeriod needs
// a migrated scratch database (0013) and runs only when TEST_DATABASE_URL is set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { prevBusinessDay, prevMonth, addDaysIso, backfillCandidates, recordPeriod, readLane } from './ledger.mjs';

test('date steps: business days skip weekends, months roll over the year', () => {
  assert.equal(prevBusinessDay('2026-10-12'), '2026-10-09'); // Monday -> Friday
  assert.equal(prevBusinessDay('2026-10-09'), '2026-10-08');
  assert.equal(prevMonth('2026-10-01'), '2026-09-01');
  assert.equal(prevMonth('2026-01-01'), '2025-12-01');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
});

const row = (records, complete = true) => ({ records, complete });

test('backfillCandidates: skips complete periods, takes missing or incomplete ones newest first', () => {
  const ledger = new Map([
    ['2026-10-09', row(10)],
    ['2026-10-08', row(5, false)], // read but incomplete -> read again
    ['2026-10-06', row(7)],
  ]);
  const w = backfillCandidates(ledger, { start: '2026-10-09', step: prevBusinessDay, count: 2 });
  assert.deepEqual(w.days, ['2026-10-08', '2026-10-07']);
  assert.equal(w.exhausted, false);
  assert.equal(w.oldestComplete, '2026-10-06');
  assert.deepEqual(backfillCandidates(ledger, { start: '2026-10-09', step: prevBusinessDay, count: 0 }).days, []);
});

test('backfillCandidates: stops when the source runs out (a streak of empty complete periods) or at the floor', () => {
  const ledger = new Map();
  let d = '2026-09-30';
  for (let i = 0; i < 10; i += 1, d = prevBusinessDay(d)) ledger.set(d, row(0));
  const w = backfillCandidates(ledger, { start: '2026-09-30', step: prevBusinessDay, count: 2, emptyStreak: 10 });
  assert.deepEqual(w.days, []);
  assert.equal(w.exhausted, true);
  // a holiday (one empty day) does not stop the walk
  const one = new Map([['2026-09-30', row(0)]]);
  assert.deepEqual(backfillCandidates(one, { start: '2026-09-30', step: prevBusinessDay, count: 1 }).days, ['2026-09-29']);
  const f = backfillCandidates(new Map(), { start: '2026-09-02', step: prevBusinessDay, count: 5, floor: '2026-09-01' });
  assert.deepEqual(f.days, ['2026-09-02', '2026-09-01']);
  assert.equal(f.reachedFloor, true);
});

const url = process.env.TEST_DATABASE_URL;
let pool;
after(async () => { if (pool) await pool.end(); });

test('recordPeriod: complete when it matches; otherwise the third identical read is accepted; changes are flagged', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: url, max: 2 });
  const lane = 'test_lane';
  await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
  try {
    const a = await recordPeriod(pool, lane, { day: '2026-01-05', expected: 100, records: 100, matches: true });
    assert.deepEqual([a.fetches, a.complete, a.previous_records], [1, true, null]);

    const b1 = await recordPeriod(pool, lane, { day: '2026-01-06', expected: 100, records: 90, matches: false });
    assert.equal(b1.complete, false);
    const b2 = await recordPeriod(pool, lane, { day: '2026-01-06', expected: 100, records: 95, matches: false });
    assert.deepEqual([b2.fetches, b2.complete, b2.records_changed, b2.previous_records], [2, false, true, 90]);
    const b3 = await recordPeriod(pool, lane, { day: '2026-01-06', expected: 100, records: 95, matches: false });
    assert.deepEqual([b3.fetches, b3.complete], [3, true]); // agreed with the read before it

    const l = await readLane(pool, lane);
    assert.equal(l.size, 2);
    assert.equal(l.get('2026-01-06').records, 95);
  } finally {
    await pool.query('DELETE FROM ops.source_dates WHERE lane = $1', [lane]);
  }
});
