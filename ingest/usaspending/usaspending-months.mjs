#!/usr/bin/env node
// ingest/usaspending/usaspending-months.mjs
// USAspending history, verified and extended one month at a time per supply class (2026-10-13).
//
// The daily lane (fetch.mjs + load.mjs, 120-day window) keeps recent months current. This walks
// back from the month before that window through months that are missing or incomplete in the
// history ledger (ops.source_dates, lane usaspending_<psc>, one row per month), --months per run
// (default 2). For each month it asks USAspending how many contract awards match
// (spending_by_award_count), fetches them all (spending_by_award), inserts any we do not have, and
// records the month as complete when the fetched count equals USAspending's count.
//
// The one-shot backfill (backfill.yml, FY2022-26) loaded before the ledger existed, so those
// months have no row: the walk re-verifies them first (anything missing is inserted, the `extra`
// column says how many), then extends history back toward --floor (FY2008, where USAspending's
// contract data starts). It stops by itself after 6 empty months in a row.
//
// CLI: node ingest/usaspending/usaspending-months.mjs --psc 5331 [--months 2] [--floor 2007-10-01]

import { fetchAllPages } from './fetch.mjs';
import { loadRecord } from './load.mjs';
import { readLane, recordPeriod, backfillCandidates, prevMonth, addDaysIso, isoOf } from '../ledger.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

const COUNT_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/';
const AWARD_TYPE_CODES = ['A', 'B', 'C', 'D'];

/** Last day of the month that starts on `iso`. */
export const monthEnd = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return isoOf(Date.UTC(y, m, 0));
};

/** USAspending's own count of contract awards for one PSC and date range. */
export async function countAwards({ psc, startDate, endDate, fetchImpl = fetch }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetchImpl(COUNT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: startDate, end_date: endDate }],
          award_type_codes: AWARD_TYPE_CODES,
          psc_codes: { require: [['Product', psc]] },
        },
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
      throw new Error(`usaspending count: HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`usaspending count: HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const json = await res.json();
    const n = Number(json?.results?.contracts);
    if (!Number.isFinite(n)) throw new Error(`usaspending count: no results.contracts in ${JSON.stringify(json).slice(0, 200)}`);
    return n;
  }
  throw new Error('unreachable');
}

export async function runUsaspendingMonths({
  pool,
  psc,
  months = 2,
  floor = '2007-10-01',
  windowDays = 120,
  now = Date.now(),
  count = countAwards,
  fetchAll = fetchAllPages,
  load = loadRecord,
  log = console.log,
}) {
  const lane = `usaspending_${psc}`;
  const tag = `usaspending-months[${psc}]`;
  const ledger = await readLane(pool, lane);
  // Start with the last whole month that ends before the daily lane's window begins.
  const windowStart = addDaysIso(isoOf(now), -windowDays);
  const start = prevMonth(`${windowStart.slice(0, 7)}-01`);
  const walk = backfillCandidates(ledger, { start, step: prevMonth, count: months, floor, emptyStreak: 6 });
  log(`${tag}: months to verify [${walk.days.join(', ')}]` +
    (walk.exhausted || walk.reachedFloor ? `; history complete back to ${walk.reachedFloor ? floor : 'where the data runs out'}` : ''));

  const result = { months: [], incomplete: [], inserted: 0, exhausted: walk.exhausted || walk.reachedFloor };
  for (const m of walk.days) {
    const startDate = m;
    const endDate = monthEnd(m);
    const expected = await count({ psc, startDate, endDate });
    const records = expected > 0 ? await fetchAll({ psc, startDate, endDate }) : [];
    let inserted = 0;
    for (const rec of records) {
      const r = await load(rec, psc);
      if (r?.inserted) inserted += 1;
    }
    const matches = records.length === expected;
    const row = await recordPeriod(pool, lane, { day: m, expected, records: records.length, pages: Math.ceil(records.length / 100), loaded: records.length, extra: inserted, matches });
    if (!row.complete) result.incomplete.push(m);
    result.inserted += inserted;
    result.months.push(m);
    log(`${tag}: ${m.slice(0, 7)} ${records.length} of ${expected} awards (${row.complete ? 'complete' : 'INCOMPLETE, will be read again'}), ${inserted} were missing and are now added`);
  }
  log(`${tag}: done. verified ${result.months.length} months, ${result.inserted} rows added, incomplete ${result.incomplete.length}`);
  return result;
}

function parseArgs(argv) {
  const a = { psc: undefined, months: 2, floor: '2007-10-01' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--psc') a.psc = argv[++i];
    else if (argv[i] === '--months') a.months = Number(argv[++i]);
    else if (argv[i] === '--floor') a.floor = argv[++i];
  }
  if (!/^[A-Z0-9]{4}$/.test(a.psc || '')) throw new Error('usaspending-months: --psc takes a 4-character class code');
  if (!Number.isInteger(a.months) || a.months < 0) throw new Error('usaspending-months: --months must be a whole number');
  if (!/^\d{4}-\d{2}-01$/.test(a.floor)) throw new Error('usaspending-months: --floor takes the first day of a month, YYYY-MM-01');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    await runUsaspendingMonths({ pool, ...args });
  } finally {
    await closePool();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
