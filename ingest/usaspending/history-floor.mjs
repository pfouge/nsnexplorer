// ingest/usaspending/history-floor.mjs
// How far back USAspending history is kept (owner decision, 2026-11-15). ONE place, read by:
//   * load.mjs                      drops records dated before the floor (floored classes only)
//   * usaspending-months.mjs        stops walking back at the floor
//   * .github/workflows/backfill.yml skips months before the floor (calls this file's CLI)
//   * db/usaspending-storage-cleanup.mjs deletes stored rows older than the floor
//
// Classes 5330 and 5331 keep their full history (no floor). Every other class keeps fiscal year 2022
// onward: action dates on or after 2021-10-01. Rows with no action date are never judged by the floor.
//
// CLI (for shell steps):  node ingest/usaspending/history-floor.mjs --psc 5340
//   prints the floor (YYYY-MM-DD) for a floored class, nothing for a class without one.

/** Classes that keep their whole history. */
export const NO_FLOOR_CLASSES = Object.freeze(['5330', '5331']);

/** First day kept for every other class (the first day of fiscal year 2022). */
export const HISTORY_FLOOR = '2021-10-01';

/** The floor for one class as 'YYYY-MM-DD', or null when the class has none. */
export function floorFor(psc) {
  return NO_FLOOR_CLASSES.includes(String(psc)) ? null : HISTORY_FLOOR;
}

/** True when a record dated `isoDate` is older than the class's floor. An undated record is never before it. */
export function isBeforeFloor(psc, isoDate) {
  const floor = floorFor(psc);
  if (!floor || !isoDate) return false;
  return isoDate < floor;
}

/** How far back a walk may go: the later of a requested floor and the class floor (a class without a floor keeps the request). */
export function effectiveFloor(psc, requested) {
  const classFloor = floorFor(psc);
  if (!classFloor) return requested;
  return !requested || requested < classFloor ? classFloor : requested;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const i = process.argv.indexOf('--psc');
  const psc = i >= 0 ? process.argv[i + 1] : undefined;
  if (!psc) {
    console.error('history-floor.mjs: --psc is required');
    process.exit(2);
  }
  const floor = floorFor(psc);
  if (floor) console.log(floor);
}
