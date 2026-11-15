// csv-split.ts — how the contract-action CSV downloads are cut into files.
// No imports, so it can be unit tested on its own.

export const contractActionsFyPath = (fsc: string, fy: number) => `/data/contract-actions-${fsc}-fy${fy}.csv`;

// Cloudflare Pages rejects any file over 25 MiB, and a busy class has more
// rows than that (5330 reached 58.6 MiB on 2026-11-15 and the deploy failed).
// So the plain file holds the latest 12 months, and each federal fiscal year
// has its own file. A row is about 0.45 KB; the cap keeps a file near 18 MiB.
export const CSV_MAX_ROWS = 40_000;

/** Federal fiscal year of an ISO date (FY2026 runs 2025-10-01 to 2026-09-30); null when unparseable. */
export function csvFiscalYear(isoDate: string | null): number | null {
  if (!isoDate || !/^\d{4}-\d{2}/.test(isoDate)) return null;
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  if (!(m >= 1 && m <= 12)) return null;
  return m >= 10 ? y + 1 : y;
}

/** The 12-month file keeps rows dated strictly after this ISO date (365 days before `today`). */
export function latestYearFloor(today: string = new Date().toISOString().slice(0, 10)): string {
  return new Date(Date.parse(`${today.slice(0, 10)}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Rows from the 365 days up to `today` (input newest first), capped at CSV_MAX_ROWS.
 * Anchored on the build date, not the newest row: USAspending carries a few
 * rows dated in the future, and those would shift the window.
 */
export function latestYearActions<T extends { actionDate: string | null }>(
  actions: T[],
  today: string = new Date().toISOString().slice(0, 10),
): T[] {
  const floor = latestYearFloor(today);
  return actions.filter((a) => a.actionDate !== null && a.actionDate.slice(0, 10) > floor).slice(0, CSV_MAX_ROWS);
}

/** Rows grouped by fiscal year, newest year first; undated rows are left out. Each year capped at CSV_MAX_ROWS. */
export function actionsByFiscalYear<T extends { actionDate: string | null }>(actions: T[]): Map<number, T[]> {
  const by = new Map<number, T[]>();
  for (const a of actions) {
    const fy = csvFiscalYear(a.actionDate);
    if (fy === null) continue;
    const list = by.get(fy);
    if (list) {
      if (list.length < CSV_MAX_ROWS) list.push(a);
    } else by.set(fy, [a]);
  }
  return new Map([...by.entries()].sort((x, y) => y[0] - x[0]));
}
