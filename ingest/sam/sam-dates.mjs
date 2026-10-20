#!/usr/bin/env node
// ingest/sam/sam-dates.mjs
// SAM.gov notices read one posting day at a time, each checked against SAM's own totalRecords
// and recorded in the history ledger (ops.source_dates, lane `sam`). Replaces the one 30-day
// query in sam-daily (fetch.mjs + load.mjs) as of 2026-10-13.
//
// Why per day: the old query paged with `offset` as a record count, but SAM's offset is a page
// index, so every run stopped after the first 1,000 of ~18,000 notices (fixed in fetch.mjs too).
// Per-day reads make each day's completeness checkable, and let the back-fill repair the days
// that were cut short and then extend history.
//
// Each run:
//   1. forward: the last N calendar days, re-read every run so status and deadline changes are
//      picked up. N adapts to the API key's allowance, read from api.data.gov's X-RateLimit-Limit
//      header on the first response: --days-high (30) when the limit is 1,000+ a day, else
//      --days-low (7). api.sam.gov did not send the header on 2026-10-13 and the key ran out after
//      ~10 requests that day, so 7 days
//      plus 2 back-fill days is the normal shape.
//   2. back-fill: up to --backfill-days older days (default 2) that are missing or incomplete,
//      newest first, down to --floor-days (365) ago, while X-RateLimit-Remaining stays above
//      --reserve (5).
// Older notices load with their own status (SAM's `active` flag), so expired ones arrive as
// expired. A day is complete when the notices read equal SAM's totalRecords for that day.
//
// CLI: node ingest/sam/sam-dates.mjs [--days-high 30] [--days-low 7] [--backfill-days 2] [--floor-days 365]

import { loadSamSolicitations } from './load.mjs';
import { readLane, recordPeriod, backfillCandidates, addDaysIso, isoOf } from '../ledger.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

const BASE_URL = 'https://api.sam.gov/opportunities/v2/search';
export const PAGE_LIMIT = 1000;
const PTYPE = 'r,o,k';
const LANE = 'sam';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prevDay = (iso) => addDaysIso(iso, -1);
/** 'YYYY-MM-DD' -> SAM's 'MM/DD/YYYY' */
export const samDate = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

/**
 * A SAM posting day is settled once a complete read was made after that day ended. SAM's dates
 * are Eastern; 05:00 UTC is midnight EST (01:00 EDT), so a read after it is safely the next day.
 * A day read only on the day itself (2026-10-17, read 11:00 UTC, then three days of a rejected
 * key) is re-read by the back-fill even after it leaves the 7-day window.
 */
export const samSettled = (row, iso) =>
  Boolean(row?.complete) && Date.parse(row.fetched_at) >= Date.parse(`${addDaysIso(iso, 1)}T05:00:00Z`);

export class QuotaError extends Error {}
/** SAM refused the API key itself (HTTP 401/403): nothing will work until the key is replaced. */
export class KeyError extends Error {}

const redact = (t) => String(t).replace(/api_key=[^&\s]+/g, 'api_key=***');
const bodyText = (t) => redact(t).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * One page (page index `page`) of notices posted on `iso`.
 * - 429: one short retry, then QuotaError (the daily allowance is spent).
 * - 401/403: KeyError at once (the key was rejected; retrying cannot help).
 * - 5xx or a network failure: one retry after 30 s, then an ordinary error for this day only.
 *   SAM answered 504 mid-run on 2026-10-15 and that one error used to end the whole run.
 */
export async function fetchSamPage({ apiKey, iso, page, fetchImpl = fetch, throttleMs = 2500, quota }) {
  const url = new URL(BASE_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', samDate(iso));
  url.searchParams.set('postedTo', samDate(iso));
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('offset', String(page)); // a PAGE INDEX (see header)
  url.searchParams.set('ptype', PTYPE);
  // A 429 from api.sam.gov almost always means the key's DAILY allowance is spent (no per-minute
  // limit was ever hit at our 2.5 s pacing), and retrying burns more of it. One short retry, then stop.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (throttleMs) await sleep(throttleMs);
    let res;
    try {
      res = await fetchImpl(url.toString());
    } catch (err) {
      if (attempt === 2) throw new Error(`SAM API unreachable for ${iso} page ${page}: ${redact(err?.cause?.code || err?.message || err)}`);
      await sleep(throttleMs ? 30000 : 0);
      continue;
    }
    const lim = Number(res.headers?.get?.('x-ratelimit-limit'));
    const rem = Number(res.headers?.get?.('x-ratelimit-remaining'));
    if (Number.isFinite(lim) && lim > 0) quota.limit = lim;
    if (Number.isFinite(rem)) quota.remaining = rem;
    quota.used += 1;
    if (res.status === 429) {
      await res.text().catch(() => {});
      if (attempt === 2) throw new QuotaError('SAM answered 429 twice: the API key\'s daily allowance is spent');
      await sleep(throttleMs ? 15000 : 0);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      throw new KeyError(`SAM.gov rejected the API key (HTTP ${res.status}: ${bodyText(body)}). Generate a new public API key on SAM.gov (Workspace > Account Details) and save it as the GitHub secret SAM_API_KEY`);
    }
    if (res.status >= 500 && attempt === 1) {
      await res.text().catch(() => {});
      await sleep(throttleMs ? 30000 : 0);
      continue;
    }
    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new Error(`SAM API returned ${res.status} for ${iso} page ${page}: ${bodyText(body)}`);
    }
    return res.json();
  }
  throw new Error('unreachable');
}

/** Every notice posted on `iso`. */
export async function fetchSamDay(o) {
  const records = [];
  let total = null;
  for (let page = 0; ; page += 1) {
    const data = await fetchSamPage({ ...o, page });
    total = Number(data.totalRecords) || 0;
    const rows = data.opportunitiesData || [];
    records.push(...rows);
    if (rows.length === 0 || records.length >= total) break;
  }
  return { records, total };
}

export async function runSamDates({
  pool,
  apiKey,
  daysHigh = 30,
  daysLow = 7,
  backfillDays = 2,
  floorDays = 365,
  reserve = 5,
  now = Date.now(),
  fetchImpl = fetch,
  throttleMs = 2500,
  load = loadSamSolicitations,
  log = console.log,
}) {
  const today = isoOf(now);
  const quota = { limit: null, remaining: null, used: 0 };
  const ledger = await readLane(pool, LANE);
  const result = { forward: [], backfill: [], incomplete: [], failed: [], quotaStop: false, keyRejected: false, exhausted: false, quota };
  // A rejected key or a spent allowance ends the run; any other error costs only that day.
  const stopOn = (err, where) => {
    if (err instanceof KeyError) { result.keyRejected = true; log(`sam-dates: ${err.message}; stopping`); return true; }
    if (err instanceof QuotaError) { result.quotaStop = true; log(`sam-dates: ${err.message}; ${where}`); return true; }
    return false;
  };

  const readDay = async (iso, kind) => {
    const { records, total } = await fetchSamDay({ apiKey, iso, fetchImpl, throttleMs, quota });
    const r = records.length ? await load(records, { pool }) : { loaded: 0, skipped: 0 };
    const matches = records.length === total;
    const row = await recordPeriod(pool, LANE, { day: iso, expected: total, records: records.length, pages: Math.ceil(total / PAGE_LIMIT), loaded: r.loaded, matches });
    if (!row.complete) result.incomplete.push(iso);
    log(`sam-dates: ${iso}${kind} ${records.length} of ${total} notices (${row.complete ? 'complete' : 'INCOMPLETE, will be read again'}), ${r.loaded} loaded`);
  };

  // 1. forward. The first request tells us the key's daily limit, which sets the window.
  let windowDays = daysLow;
  let iso = prevDay(today);
  for (let i = 0; i < windowDays; i += 1) {
    const day = i === 0 ? today : iso;
    try {
      await readDay(day, '');
      result.forward.push(day);
    } catch (err) {
      if (stopOn(err, 'stopping, the rest waits for tomorrow')) break;
      result.failed.push(day);
      log(`sam-dates: ${day} failed: ${redact(err.message)}`);
    }
    if (i === 0) {
      windowDays = quota.limit !== null && quota.limit >= 1000 ? daysHigh : daysLow;
      log(`sam-dates: API key allowance ${quota.limit ?? 'unknown'} requests a day; re-reading the last ${windowDays} days`);
    } else {
      iso = prevDay(iso);
    }
  }

  // 2. back-fill older days, newest first, while the allowance lasts.
  if (!result.quotaStop && !result.keyRejected) {
    const floor = addDaysIso(today, -floorDays);
    const walk = backfillCandidates(ledger, { start: iso, step: prevDay, count: backfillDays, floor, emptyStreak: 30, settled: samSettled });
    result.exhausted = walk.exhausted || walk.reachedFloor;
    for (const day of walk.days) {
      if (quota.remaining !== null && quota.remaining <= reserve) {
        log(`sam-dates: ${quota.remaining} requests left today (reserve ${reserve}); back-fill waits for tomorrow`);
        break;
      }
      try {
        await readDay(day, ' [back-fill]');
        result.backfill.push(day);
      } catch (err) {
        if (stopOn(err, 'back-fill stops')) break;
        result.failed.push(day);
        log(`sam-dates: ${day} [back-fill] failed: ${redact(err.message)}`);
      }
    }
    if (result.exhausted) log(`sam-dates: history complete back to ${floor}`);
  }

  log(`sam-dates: done. forward ${result.forward.length} days, back-fill ${result.backfill.length} [${result.backfill.join(', ')}], ` +
    `incomplete ${result.incomplete.length}${result.incomplete.length ? ` [${result.incomplete.join(', ')}]` : ''}, ` +
    `failed ${result.failed.length}${result.failed.length ? ` [${result.failed.join(', ')}]` : ''}${result.keyRejected ? ', API KEY REJECTED' : ''}; requests used ${quota.used}, remaining ${quota.remaining ?? 'unknown'} of ${quota.limit ?? 'unknown'}`);
  return result;
}

function parseArgs(argv) {
  const a = { daysHigh: 30, daysLow: 7, backfillDays: 2, floorDays: 365 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days-high') a.daysHigh = Number(argv[++i]);
    else if (argv[i] === '--days-low') a.daysLow = Number(argv[++i]);
    else if (argv[i] === '--backfill-days') a.backfillDays = Number(argv[++i]);
    else if (argv[i] === '--floor-days') a.floorDays = Number(argv[++i]);
  }
  for (const k of Object.keys(a)) if (!Number.isInteger(a[k]) || a[k] < 0) throw new Error(`sam-dates: --${k} must be a whole number`);
  return a;
}

async function main() {
  const apiKey = process.env.SAM_API_KEY;
  if (!apiKey) throw new Error('sam-dates: SAM_API_KEY is required');
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    const r = await runSamDates({ pool, apiKey, ...args });
    // A failed day makes the run red. Running out of the daily allowance does not: nothing is
    // lost (the ledger re-reads what was missed tomorrow), and a red run would start the
    // retry job, which only spends 429s. It is reported as a warning instead.
    if (r.failed.length || r.keyRejected) process.exitCode = 1;
    if (r.keyRejected) console.log('::error::SAM.gov rejected the API key. Generate a new public API key on SAM.gov (Workspace > Account Details) and save it as the GitHub secret SAM_API_KEY. Missed days are re-read automatically once it works.');
    if (r.quotaStop) console.log(`::warning::SAM.gov API key allowance ran out after ${r.quota.used} requests; ${r.forward.length} recent days read, the rest continues tomorrow`);
  } finally {
    await closePool();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(String(err?.stack || err).replace(/api_key=[^&\s]+/g, 'api_key=***'));
    process.exit(1);
  });
}
