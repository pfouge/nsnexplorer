// ingest/ledger.mjs
// The history ledger (ops.source_dates, migration 0013) shared by every date-based lane.
//
// One row per period (a posting date, or a month) per lane. A lane reads its newest periods, then
// walks back through periods that are missing or incomplete, a few per run (backfillCandidates).
// Data loaded before the ledger existed has no row, so it counts as unverified and is re-read
// first; after that the walk extends history until the source runs out (a run of empty periods)
// or reaches the lane's floor.
//
// A period is complete when what we read matches what the source says exists (`matches`), or,
// when the source gives no count or never matches, after three reads that agree (the third read
// with the same record count is accepted, so one odd period cannot be retried forever).

const DAY_MS = 86400000;

export const isoOf = (d) => new Date(d).toISOString().slice(0, 10);
export const addDaysIso = (iso, n) => isoOf(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS);

/** Previous Mon-Fri date before `iso` (UTC). */
export function prevBusinessDay(iso) {
  let d = addDaysIso(iso, -1);
  for (;;) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDaysIso(d, -1);
  }
}

/** First day of the month before the month of `iso`. */
export function prevMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

/** All ledger rows of `lane` as a Map keyed by ISO day. */
export async function readLane(pool, lane) {
  const { rows } = await pool.query(
    `SELECT day::text AS day, expected, records, pages, loaded, extra, complete, fetches, records_changed, fetched_at
       FROM ops.source_dates WHERE lane = $1`,
    [lane]
  );
  return new Map(rows.map((r) => [r.day, r]));
}

/**
 * Records one read of one period. `matches` = the read agrees with the source's own count.
 * @returns {Promise<{fetches: number, complete: boolean, records_changed: boolean, previous_records: number|null}>}
 */
export async function recordPeriod(pool, lane, { day, expected = null, records, pages = 0, loaded = 0, extra = 0, matches }) {
  const { rows } = await pool.query(
    `WITH prev AS (SELECT records FROM ops.source_dates WHERE lane = $1 AND day = $2::date)
     INSERT INTO ops.source_dates AS t (lane, day, expected, records, pages, loaded, extra, complete)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (lane, day) DO UPDATE SET
       expected = EXCLUDED.expected, records = EXCLUDED.records, pages = EXCLUDED.pages,
       loaded = EXCLUDED.loaded, extra = EXCLUDED.extra,
       complete = EXCLUDED.complete OR (t.fetches >= 2 AND t.records = EXCLUDED.records),
       records_changed = t.records_changed OR t.records <> EXCLUDED.records,
       fetches = t.fetches + 1, fetched_at = now()
     RETURNING fetches, complete, records_changed, (SELECT records FROM prev) AS previous_records`,
    [lane, day, expected, records, pages, loaded, extra, Boolean(matches)]
  );
  return rows[0];
}

/**
 * The next periods to back-fill, newest first: walk back from `start` (inclusive) with `step`,
 * skipping settled periods, until `count` are found, the walk passes `floor`, or `emptyStreak`
 * consecutive complete periods held no records (the source has run out; returns exhausted: true).
 *
 * @param {Map<string, object>} ledger from readLane
 * `settled(row, day)` decides whether a recorded period can be skipped. The default is its
 * `complete` flag. Day lanes pass a stricter rule: complete AND read on a later day, because a
 * day read on the day itself matched the source's count only as it stood then (2026-10-17's SAM
 * read at 11:00 UTC, before an outage, is the case that prompted this).
 *
 * @param {{ start: string, step: (iso: string) => string, count: number, floor?: string, emptyStreak?: number, maxSteps?: number, settled?: (row: object, day: string) => boolean }} o
 * @returns {{ days: string[], exhausted: boolean, reachedFloor: boolean, oldestComplete: string|null }}
 */
export function backfillCandidates(ledger, { start, step, count, floor = '1900-01-01', emptyStreak = 10, maxSteps = 5000, settled = (row) => row.complete }) {
  const days = [];
  if (!(count > 0)) return { days, exhausted: false, reachedFloor: false, oldestComplete: oldestComplete(ledger) };
  let empty = 0;
  let d = start;
  for (let i = 0; i < maxSteps && d >= floor; i += 1, d = step(d)) {
    const row = ledger.get(d);
    if (row && settled(row, d)) {
      empty = row.records === 0 ? empty + 1 : 0;
      if (empty >= emptyStreak) return { days, exhausted: true, reachedFloor: false, oldestComplete: oldestComplete(ledger) };
      continue;
    }
    empty = 0;
    days.push(d);
    if (days.length >= count) return { days, exhausted: false, reachedFloor: false, oldestComplete: oldestComplete(ledger) };
  }
  return { days, exhausted: false, reachedFloor: d < floor, oldestComplete: oldestComplete(ledger) };
}

function oldestComplete(ledger) {
  let min = null;
  for (const [day, row] of ledger) if (row.complete && row.records > 0 && (min === null || day < min)) min = day;
  return min;
}
