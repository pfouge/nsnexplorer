#!/usr/bin/env node
// ingest/dibbs/dibbs-dates.mjs
// DIBBS grids (awards, solicitations) read one posting date at a time, checked against DIBBS's own
// record count, recorded in the history ledger (ops.source_dates), and back-filled a few dates per
// run. Replaces awards-daily.mjs (0057).
//
//   --grid awd  (ingest-daily, lane dibbs_awd): the last --days business days that are new, not yet
//               settled (a complete read on a later day than the date) or incomplete; then
//               --backfill-days older dates. Each date: award totals (pub.contract_actions), then
//               unit prices (pub.price_points).
//   --grid rfq  (rfq-fast, lane dibbs_rfq): back-fill only. rfq-fast and rfq-reconcile already
//               re-read the newest 25 business days every day, so the walk starts at
//               --backfill-start (default 26) business days back. Each date: solicitations
//               (pub.solicitations, loaded as expired/cancelled by their own dates), then the stored
//               awards that point at them are priced from the database (rejoin.mjs).
//
// Completeness: DIBBS prints "Records Found: N" above each grid. A date is complete when the rows
// parsed across all its pages equal N (or, with no N, after three reads that agree; see
// ingest/ledger.mjs). An incomplete date stays in the walk and is read again next run. Dates
// loaded before the ledger existed have no row, so the walk re-reads them first: that is how
// partial data from the early days gets repaired, before history is extended further back.
//
// The walk stops by itself when DIBBS runs out (10 business days in a row with no records) or at
// --floor. Budgets: no new date after --budget-min; a date still downloading at --hard-budget-min is
// abandoned (DeadlineError). What is left waits for the next run. Exit 1 if a date failed, so the
// workflow's fresh-runner retry runs; it skips everything already recorded.
//
// CLI:
//   node ingest/dibbs/dibbs-dates.mjs --grid awd --days 7 --backfill-days 2 --out /tmp/dibbs-awd
//   node ingest/dibbs/dibbs-dates.mjs --grid rfq --backfill-days 2 --out /tmp/dibbs-rfq-back

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar, fetchDate, businessDays, DeadlineError } from './fetch.mjs';
import { parseAwardGrid, parseRfqGrid, parseRecordsFound } from './parse.mjs';
import { loadAwardGridActions, loadPricePointsFromAwards, loadRfqSolicitations } from './load.mjs';
import { rejoinForSolicitations } from './rejoin.mjs';
import { readLane, recordPeriod, backfillCandidates, prevBusinessDay, addDaysIso, isoOf } from '../ledger.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

// A date counts as settled once one complete read happened on a later UTC day than the date itself.
// Was 2 (a second read the day after); the first 0058 run re-read 5 dates and every count was
// unchanged, so the extra read only cost DIBBS time (~80 pages a day at ~20 s a page by day).
// records_changed in the ledger shows if that ever stops being true.
export const SETTLE_DAYS = 1;
export const EMPTY_STREAK = 10;

/** 'MM-DD-YYYY' -> 'YYYY-MM-DD' */
export function isoDay(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split('-');
  return `${y}-${m}-${d}`;
}
/** 'YYYY-MM-DD' -> 'MM-DD-YYYY' */
export function dibbsDay(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}-${d}-${y}`;
}

/** A window date needs a read: never read, incomplete, or not yet read SETTLE_DAYS after the date. */
export function needsRead(row, iso) {
  if (!row || !row.complete) return true;
  return new Date(row.fetched_at).getTime() < Date.parse(`${addDaysIso(iso, SETTLE_DAYS)}T00:00:00Z`);
}

const poolFull = (err) => /EMAXCONNSESSION|max clients reached/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`);

export async function withPoolRetry(fn, { tries = 3, waitMs = 120000, log = console.log } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!poolFull(err) || attempt >= tries) throw err;
      log(`dibbs-dates: database connection limit reached (attempt ${attempt} of ${tries}); retrying in ${waitMs / 1000} s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const GRIDS = {
  awd: { lane: 'dibbs_awd', prefix: 'awd-', parse: parseAwardGrid, extraName: 'price points' },
  rfq: { lane: 'dibbs_rfq', prefix: 'rfq-', parse: parseRfqGrid, extraName: 'price points re-joined' },
};

async function parseDir(dir, grid) {
  const { prefix, parse } = GRIDS[grid];
  const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.html'));
  const records = [];
  let expected = null;
  for (const f of files) {
    const html = await readFile(path.join(dir, f), 'utf8');
    records.push(...parse(html).records);
    if (/-p1\.html$/.test(f)) expected = parseRecordsFound(html);
  }
  return { pages: files.length, records, expected };
}

const tally = (into, from) => {
  for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v;
};

/** Default per-date loaders. Each returns { loaded, extra, skipReasons, extraSkipReasons }. */
export function defaultProcessors() {
  return {
    awd: async (records, { pool }) => {
      const actions = await loadAwardGridActions(records);
      const prices = await loadPricePointsFromAwards(records, { pool });
      const skipReasons = {};
      for (const s of actions.skipped || []) skipReasons[s.reason] = (skipReasons[s.reason] || 0) + 1;
      return { loaded: actions.loaded, extra: prices.loaded, skipReasons, extraSkipReasons: prices.skipReasons };
    },
    rfq: async (records, { pool, today }) => {
      const res = await loadRfqSolicitations(records, { pool, today });
      const re = await rejoinForSolicitations(pool, records.map((r) => r.solicitation));
      return { loaded: res.loaded, extra: re.loaded, skipReasons: res.skipReasons, extraSkipReasons: re.skipReasons };
    },
  };
}

/**
 * @returns {Promise<{loaded: string[], forward: string[], backfill: string[], settled: number, failed: string[],
 *   left: string[], incomplete: string[], exhausted: boolean, skipReasons: object, extraSkipReasons: object}>}
 */
export async function runDibbsDates({
  pool,
  grid = 'awd',
  days = 7,
  backfillDays = 2,
  backfillStart = 26,
  floor = '2015-01-01',
  out,
  budgetMs = 105 * 60000,
  hardBudgetMs = 130 * 60000,
  now = Date.now(),
  startedAt = Date.now(),
  fetchDateImpl = fetchDate,
  processors = defaultProcessors(),
  poolRetryWaitMs = 120000,
  log = console.log,
}) {
  const { lane, extraName } = GRIDS[grid];
  const tag = `dibbs-dates[${grid}]`;
  const ledger = await readLane(pool, lane);
  const windowDates = days > 0 ? businessDays(days, now) : [];
  const forward = windowDates.filter((d) => needsRead(ledger.get(isoDay(d)), isoDay(d)));
  const start = windowDates.length
    ? prevBusinessDay(isoDay(windowDates.at(-1)))
    : isoDay(businessDays(backfillStart, now).at(-1));
  const walk = backfillCandidates(ledger, { start, step: prevBusinessDay, count: backfillDays, floor, emptyStreak: EMPTY_STREAK, settled: (row, d) => !needsRead(row, d) });
  const backfill = walk.days.map(dibbsDay);
  const todo = [...forward, ...backfill];
  log(`${tag}: window ${windowDates.length} dates, to read ${forward.length} [${forward.join(', ')}]; ` +
    `back-fill ${backfill.length} [${backfill.join(', ')}]` +
    (walk.exhausted ? '; history complete back to where DIBBS runs out' : walk.reachedFloor ? `; history complete back to the floor ${floor}` : ''));

  const result = {
    loaded: [], forward, backfill, settled: windowDates.length - forward.length, failed: [], left: [], incomplete: [],
    exhausted: walk.exhausted, skipReasons: {}, extraSkipReasons: {},
  };
  const today = isoOf(now);
  let jar = new CookieJar();
  for (let i = 0; i < todo.length; i += 1) {
    const date = todo[i];
    const kind = i < forward.length ? '' : ' [back-fill]';
    if (Date.now() - startedAt > budgetMs) {
      result.left = todo.slice(i);
      log(`${tag}: time budget reached; leaving ${result.left.join(', ')} for the next run`);
      break;
    }
    const dir = path.join(out, date);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      await fetchDateImpl(jar, dir, grid, date, undefined, { deadline: startedAt + hardBudgetMs });
    } catch (err) {
      if (err instanceof DeadlineError || err?.name === 'DeadlineError') {
        result.left = todo.slice(i);
        log(`${tag}: hard time limit reached during ${date}; leaving ${result.left.join(', ')} for the next run`);
        break;
      }
      result.failed.push(date);
      log(`${tag}: ${date}${kind} fetch failed (${err.cause?.code || err.name}: ${err.message}); continuing`);
      jar = new CookieJar();
      continue;
    }

    const { pages, records, expected } = await parseDir(dir, grid);
    const retry = { log, waitMs: poolRetryWaitMs };
    const r = await withPoolRetry(() => processors[grid](records, { pool, today }), retry);
    tally(result.skipReasons, r.skipReasons);
    tally(result.extraSkipReasons, r.extraSkipReasons);
    const matches = expected === null ? records.length === 0 : records.length === expected;
    const row = await withPoolRetry(
      () => recordPeriod(pool, lane, { day: isoDay(date), expected, records: records.length, pages, loaded: r.loaded, extra: r.extra, matches }),
      retry
    );
    if (!row.complete) result.incomplete.push(date);
    const count = expected === null ? `${records.length} records (no count shown)` : `${records.length} of ${expected} records`;
    const state = row.complete ? (matches ? 'complete' : 'accepted after repeated identical reads') : 'INCOMPLETE, will be read again';
    const reread = row.previous_records === null || row.previous_records === undefined
      ? 'first read'
      : `read ${row.fetches}, ${row.previous_records === records.length ? 'unchanged' : `was ${row.previous_records}`}`;
    log(`${tag}: ${date}${kind} ${pages} pages, ${count} (${state}), ${r.loaded} loaded, ${r.extra} ${extraName} (${reread})`);
    result.loaded.push(date);
  }

  log(`${tag}: done. loaded ${result.loaded.length} [${result.loaded.join(', ')}]; settled ${result.settled}; ` +
    `incomplete ${result.incomplete.length}${result.incomplete.length ? ` [${result.incomplete.join(', ')}]` : ''}; ` +
    `failed ${result.failed.length}${result.failed.length ? ` [${result.failed.join(', ')}]` : ''}; ` +
    `left for next run ${result.left.length}${result.left.length ? ` [${result.left.join(', ')}]` : ''}`);
  log(`${tag}: skip reasons ${JSON.stringify(result.skipReasons)}; ${extraName} skip reasons ${JSON.stringify(result.extraSkipReasons)}`);
  return result;
}

function parseArgs(argv) {
  const args = { grid: 'awd', days: undefined, backfillDays: 2, backfillStart: 26, floor: '2015-01-01', out: undefined, budgetMin: 105, hardBudgetMin: 130 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--grid') args.grid = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--backfill-days') args.backfillDays = Number(argv[++i]);
    else if (a === '--backfill-start') args.backfillStart = Number(argv[++i]);
    else if (a === '--floor') args.floor = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--budget-min') args.budgetMin = Number(argv[++i]);
    else if (a === '--hard-budget-min') args.hardBudgetMin = Number(argv[++i]);
  }
  if (!GRIDS[args.grid]) throw new Error('dibbs-dates: --grid must be awd or rfq');
  args.days ??= args.grid === 'awd' ? 7 : 0;
  if (!Number.isInteger(args.days) || args.days < 0) throw new Error('dibbs-dates: --days must be a whole number');
  if (!Number.isInteger(args.backfillDays) || args.backfillDays < 0) throw new Error('dibbs-dates: --backfill-days must be a whole number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.floor)) throw new Error('dibbs-dates: --floor takes YYYY-MM-DD');
  if (!args.out) throw new Error('dibbs-dates: --out is required');
  if (!(args.budgetMin > 0) || !(args.hardBudgetMin >= args.budgetMin)) throw new Error('dibbs-dates: need 0 < --budget-min <= --hard-budget-min');
  return args;
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    const r = await runDibbsDates({
      pool, grid: args.grid, days: args.days, backfillDays: args.backfillDays, backfillStart: args.backfillStart,
      floor: args.floor, out: args.out, startedAt,
      budgetMs: args.budgetMin * 60000, hardBudgetMs: args.hardBudgetMin * 60000,
    });
    if (r.failed.length) process.exitCode = 1;
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
