#!/usr/bin/env node
// ingest/dibbs/awards-daily.mjs
// The daily DIBBS award lane (ingest-daily, job `dibbs`): fetch, load and price-join award posting
// dates one at a time, skipping dates that are already settled.
//
// Why (2026-10-13): DIBBS answers about 23 s per grid page. The old job re-fetched the last 7
// business days in full every day (~550 pages, 3.5-4.5 h) and loaded nothing until the whole
// crawl was done, so on 5 of 10 days (2026-10-05..12) it hit the job's 2h30 limit and kept nothing.
//
// Now:
//   - ops.dibbs_award_dates records each loaded posting date. A date is re-read until one read
//     happened at least SETTLE_DAYS days after the date itself, then it is skipped. A normal day
//     reads the newest date for the first time and the one before it a second time.
//   - Each date is loaded (pub.contract_actions, then pub.price_points) as soon as it is fetched,
//     so a slow day keeps every date it finished.
//   - --budget-min: no new date is started after this many minutes; --hard-budget-min: a date
//     still being fetched at this point is abandoned (DeadlineError). Both end the run cleanly, well
//     inside the job timeout, and the remaining dates are picked up by the next run.
//   - A date that fails (network) is reported and the process exits 1 so the workflow's retry job
//     (a fresh runner) runs; it skips everything this run already loaded.
//   - A full Supabase session pooler (EMAXCONNSESSION) is waited out and retried per load.
//
// CLI:
//   node ingest/dibbs/awards-daily.mjs --days 7 --out /tmp/dibbs-awd [--budget-min 105] [--hard-budget-min 130]

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar, fetchDate, businessDays, DeadlineError } from './fetch.mjs';
import { parseAwardGrid } from './parse.mjs';
import { loadAwardGridActions, loadPricePointsFromAwards } from './load.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

export const SETTLE_DAYS = 2;
const DAY_MS = 86400000;

/** 'MM-DD-YYYY' -> 'YYYY-MM-DD' */
export function isoDay(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split('-');
  return `${y}-${m}-${d}`;
}

/**
 * The window dates (MM-DD-YYYY, newest first) that still need a read: never loaded, or last read
 * less than SETTLE_DAYS days after the date itself.
 * @param {string[]} windowDates
 * @param {Map<string, {fetched_at: Date|string}>} state keyed by ISO day
 */
export function pickDates(windowDates, state) {
  return windowDates.filter((d) => {
    const row = state.get(isoDay(d));
    if (!row) return true;
    const settledAt = Date.parse(`${isoDay(d)}T00:00:00Z`) + SETTLE_DAYS * DAY_MS;
    return new Date(row.fetched_at).getTime() < settledAt;
  });
}

export async function readState(pool, windowDates) {
  const { rows } = await pool.query(
    `SELECT day::text AS day, records, fetches, fetched_at FROM ops.dibbs_award_dates WHERE day = ANY($1::date[])`,
    [windowDates.map(isoDay)]
  );
  return new Map(rows.map((r) => [r.day, r]));
}

export async function recordDate(pool, { day, pages, records, loaded, pricePoints }) {
  const { rows } = await pool.query(
    `INSERT INTO ops.dibbs_award_dates AS t (day, pages, records, loaded, price_points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (day) DO UPDATE SET
       pages = EXCLUDED.pages, records = EXCLUDED.records, loaded = EXCLUDED.loaded,
       price_points = EXCLUDED.price_points, fetches = t.fetches + 1, fetched_at = now(),
       records_changed = t.records_changed OR t.records <> EXCLUDED.records
     RETURNING fetches, records_changed`,
    [isoDay(day), pages, records, loaded, pricePoints]
  );
  return rows[0];
}

const poolFull = (err) => /EMAXCONNSESSION|max clients reached/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`);

export async function withPoolRetry(fn, { tries = 3, waitMs = 120000, log = console.log } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!poolFull(err) || attempt >= tries) throw err;
      log(`awards-daily: database connection limit reached (attempt ${attempt} of ${tries}); retrying in ${waitMs / 1000} s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function parseDir(dir) {
  const files = (await readdir(dir)).filter((f) => f.startsWith('awd-') && f.endsWith('.html'));
  const records = [];
  for (const f of files) records.push(...parseAwardGrid(await readFile(path.join(dir, f), 'utf8')).records);
  return { pages: files.length, records };
}

const tally = (into, from) => {
  for (const [k, v] of Object.entries(from || {})) into[k] = (into[k] || 0) + v;
};

/**
 * @returns {Promise<{loaded: string[], settled: string[], failed: string[], left: string[], skipReasons: object, joinSkipReasons: object}>}
 */
export async function runAwardsDaily({
  pool,
  days = 7,
  out,
  budgetMs = 105 * 60000,
  hardBudgetMs = 130 * 60000,
  now = Date.now(),
  startedAt = Date.now(),
  fetchDateImpl = fetchDate,
  loadActions = loadAwardGridActions,
  loadPrices = loadPricePointsFromAwards,
  poolRetryWaitMs = 120000,
  log = console.log,
}) {
  const windowDates = businessDays(days, now);
  const state = await readState(pool, windowDates);
  const todo = pickDates(windowDates, state);
  const settled = windowDates.filter((d) => !todo.includes(d));
  log(`awards-daily: window ${windowDates.length} dates; to read ${todo.length} [${todo.join(', ')}]; settled ${settled.length}`);

  const result = { loaded: [], settled, failed: [], left: [], skipReasons: {}, joinSkipReasons: {} };
  let jar = new CookieJar();
  for (let i = 0; i < todo.length; i += 1) {
    const date = todo[i];
    if (Date.now() - startedAt > budgetMs) {
      result.left = todo.slice(i);
      log(`awards-daily: time budget reached; leaving ${result.left.join(', ')} for the next run`);
      break;
    }
    const dir = path.join(out, date);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      await fetchDateImpl(jar, dir, 'awd', date, undefined, { deadline: startedAt + hardBudgetMs });
    } catch (err) {
      if (err instanceof DeadlineError || err?.name === 'DeadlineError') {
        result.left = todo.slice(i);
        log(`awards-daily: hard time limit reached during ${date}; leaving ${result.left.join(', ')} for the next run`);
        break;
      }
      result.failed.push(date);
      log(`awards-daily: ${date} fetch failed (${err.cause?.code || err.name}: ${err.message}); continuing`);
      jar = new CookieJar();
      continue;
    }

    const { pages, records } = await parseDir(dir);
    const retry = { log, waitMs: poolRetryWaitMs };
    const actions = await withPoolRetry(() => loadActions(records), retry);
    const prices = await withPoolRetry(() => loadPrices(records, { pool }), retry);
    const reasons = {};
    for (const s of actions.skipped || []) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    tally(result.skipReasons, reasons);
    tally(result.joinSkipReasons, prices.skipReasons);
    const prev = state.get(isoDay(date));
    const row = await withPoolRetry(
      () => recordDate(pool, { day: date, pages, records: records.length, loaded: actions.loaded, pricePoints: prices.loaded }),
      retry
    );
    const note = prev ? `re-read ${row.fetches}, records ${prev.records === records.length ? 'unchanged' : `changed from ${prev.records}`}` : 'first read';
    log(`awards-daily: ${date} ${pages} pages, ${records.length} records, ${actions.loaded} loaded, ${prices.loaded} price points (${note})`);
    result.loaded.push(date);
  }

  log(`awards-daily: done. loaded ${result.loaded.length} [${result.loaded.join(', ')}]; settled ${settled.length}; ` +
    `failed ${result.failed.length}${result.failed.length ? ` [${result.failed.join(', ')}]` : ''}; ` +
    `left for next run ${result.left.length}${result.left.length ? ` [${result.left.join(', ')}]` : ''}`);
  log(`awards-daily: skip reasons ${JSON.stringify(result.skipReasons)}; price join skip reasons ${JSON.stringify(result.joinSkipReasons)}`);
  return result;
}

function parseArgs(argv) {
  const args = { days: 7, out: undefined, budgetMin: 105, hardBudgetMin: 130 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--budget-min') args.budgetMin = Number(argv[++i]);
    else if (a === '--hard-budget-min') args.hardBudgetMin = Number(argv[++i]);
  }
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error('awards-daily: --days must be a positive integer');
  if (!args.out) throw new Error('awards-daily: --out is required');
  if (!(args.budgetMin > 0) || !(args.hardBudgetMin >= args.budgetMin)) throw new Error('awards-daily: need 0 < --budget-min <= --hard-budget-min');
  return args;
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    const r = await runAwardsDaily({
      pool, days: args.days, out: args.out, startedAt,
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
