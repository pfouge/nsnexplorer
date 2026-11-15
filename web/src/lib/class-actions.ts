// class-actions.ts — pure helpers for the class-level contract actions that the
// build used to hold in memory row by row (see class-actions-db.ts for the SQL).
//
// "Class-level" rows are pub.contract_actions rows whose psc is a catalog class
// and whose raw.nsn is NOT a catalog NSN. The build now keeps one small
// ClassActionSummary per class instead of every row.
//
// No runtime imports: node --test loads this file directly.

import type { ContractActionRecord } from './shared';

/** One slim row: just what the "Right now" stats on a class page read. */
export interface ClassPulseRow {
  actionDate: string; // ISO date
  obligation: number | null;
  recipientUei: string | null;
  recipientName: string | null;
}

export interface ClassActionSummary {
  /** Class-level rows in this class (every source, dated or not). */
  count: number;
  /** Sum of their obligations (null counts as 0; negative de-obligations included). */
  obligated: number;
  /** The newest rows, newest first (date desc, undated last, then id asc), at most RECENT_ACTION_ROWS. */
  recent: ContractActionRecord[];
  /** Rows that are USAspending records (not DIBBS, source host usaspending.gov), dated or not. */
  usaspendingCount: number;
  /** Federal fiscal years that have at least one dated USAspending row, newest first. */
  usaspendingFiscalYears: { fy: number; count: number }[];
  /** Newest ISO date among the class's dated rows (any year, future included), or null when none is dated. */
  latestDate: string | null;
  /** Dated rows from pulseLookbackFloor(today) up to and including today, newest first. */
  pulseRows: ClassPulseRow[];
}

export const RECENT_ACTION_ROWS = 25;

/**
 * Longest window lib/class-pulse.ts looks back over: SUPPLIER_WINDOW_DAYS (365),
 * which is longer than AWARD_WINDOW_DAYS (90). class-actions.test.ts pins this
 * to the exported constants so the two cannot drift apart.
 */
export const PULSE_LOOKBACK_DAYS = 365;
/** Safety margin on top of the look-back, so an off-by-one in either place cannot drop a row. */
export const PULSE_LOOKBACK_MARGIN_DAYS = 7;

/** Earliest action_date (ISO) the class pulse could read when built on `today` (ISO). */
export function pulseLookbackFloor(today: string): string {
  const ms = Date.parse(`${today.slice(0, 10)}T00:00:00Z`) - (PULSE_LOOKBACK_DAYS + PULSE_LOOKBACK_MARGIN_DAYS) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The rows to feed buildClassPulse for one class, as {date, amount, recipient}.
 * buildClassPulse's awarded90 is null only when NO award in the class (any year)
 * is dated; so when the class has dated rows but none inside the look-back
 * (all older, or all in the future), one zero-amount marker row carrying the
 * newest date stands in for them. That date is outside both windows by
 * construction, so it changes no count, sum or supplier set.
 */
export function pulseAwardRows(
  summary: ClassActionSummary | undefined
): { date: string; amount: number; recipientUei: string | null; recipientName: string | null }[] {
  if (!summary) return [];
  const rows = summary.pulseRows.map((r) => ({
    date: r.actionDate,
    amount: r.obligation ?? 0,
    recipientUei: r.recipientUei,
    recipientName: r.recipientName,
  }));
  if (rows.length === 0 && summary.latestDate) {
    rows.push({ date: summary.latestDate, amount: 0, recipientUei: null, recipientName: null });
  }
  return rows;
}

/** Fiscal years with USAspending rows for a class, newest first (empty when none). */
export function usaspendingFiscalYears(summary: ClassActionSummary | undefined): number[] {
  return (summary?.usaspendingFiscalYears ?? []).map((y) => y.fy);
}

/** True when the class has any USAspending class-level row (dated or not): the CSV downloads exist. */
export function hasUsaspendingActions(summary: ClassActionSummary | undefined): boolean {
  return (summary?.usaspendingCount ?? 0) > 0;
}

/**
 * A USAspending record: not a DIBBS award row, and its source_url host is
 * usaspending.gov or a subdomain of it.
 */
export function isUsaspendingRow(awardUid: string, sourceUrl: string): boolean {
  if (awardUid.startsWith('DIBBS-')) return false;
  try {
    const host = new URL(sourceUrl).hostname;
    return host === 'usaspending.gov' || host.endsWith('.usaspending.gov');
  } catch {
    return false;
  }
}

/**
 * SQL-side equivalent of the host test in isUsaspendingRow, for Postgres `~*`
 * (also valid as a case-insensitive JS RegExp): scheme://, optional userinfo,
 * optional subdomain labels ending in a dot, usaspending.gov, optional port,
 * then a path/query/fragment delimiter or the end. Query-string or look-alike
 * hosts (usaspending.gov.evil.com, evilusaspending.gov) do not match.
 * Checked against the JS test on every row of the local database
 * (see the PR report); the build also warns when the two disagree.
 */
export const USASPENDING_URL_REGEX =
  '^\\s*[a-z][a-z0-9+.-]*://([^/?#\\\\]*@)?([^/?#\\\\@:]*\\.)?usaspending\\.gov(:[0-9]{0,5})?([/?#\\\\]|\\s*$)';

/** Fiscal-year bounds as ISO dates: [start, endExclusive) for FY `fy` (FY2026 = 2025-10-01 up to 2026-10-01). */
export function fiscalYearBounds(fy: number): { start: string; endExclusive: string } {
  const pad = (n: number) => String(n).padStart(4, '0');
  return { start: `${pad(fy - 1)}-10-01`, endExclusive: `${pad(fy)}-10-01` };
}
