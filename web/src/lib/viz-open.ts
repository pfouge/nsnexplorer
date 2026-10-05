// lib/viz-open.ts — pure number-crunching for the open-demand charts: the
// closing calendar and the bid-window map. No pg, no DOM.

import { daysBetween, niceMax, ticks } from './viz.ts';

/** ISO date + n days (UTC arithmetic, so no daylight-saving drift). */
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- closing calendar

export const CALENDAR_DAYS = 30;
export const CALENDAR_WARN_DAYS = 7;
export const CALENDAR_MIN = 5;

export interface CalendarBar {
  day: number;
  date: string;
  count: number;
  warn: boolean;
}

/**
 * One bar per day for the 30 days starting at `today`. `counts[i]` is the
 * number of open solicitations whose return_by falls `i` days after today.
 * Null when fewer than 5 solicitations close inside the window.
 */
export function buildCalendar(counts: readonly number[], today: string): { bars: CalendarBar[]; total: number; max: number } | null {
  const bars: CalendarBar[] = Array.from({ length: CALENDAR_DAYS }, (_, i) => ({
    day: i,
    date: addDays(today, i),
    count: counts[i] ?? 0,
    warn: i < CALENDAR_WARN_DAYS,
  }));
  const total = bars.reduce((a, b) => a + b.count, 0);
  if (total < CALENDAR_MIN) return null;
  return { bars, total, max: Math.max(...bars.map((b) => b.count)) };
}

/** Folds (day offset, count) rows from SQL into a 30-slot array. */
export function foldCalendarRows(rows: { d: number; n: number }[]): number[] {
  const out = new Array<number>(CALENDAR_DAYS).fill(0);
  for (const r of rows) if (r.d >= 0 && r.d < CALENDAR_DAYS) out[r.d] += r.n;
  return out;
}

export function whenLabel(day: number): string {
  return day === 0 ? 'Today' : day === 1 ? 'In 1 day' : `In ${day} days`;
}

// ---------------------------------------------------------------- bid-window map

export type Competition = 'open' | 'restricted' | 'unknown';

export interface BidSolicitation {
  solNumber: string;
  nsn: string | null;
  name: string;
  quantity: number | null;
  returnBy: string | null;
  competition: Competition;
}
export interface BidMark {
  solNumber: string;
  nsn: string | null;
  name: string;
  quantity: number;
  /** days until the solicitation closes, 0..30 */
  days: number;
  competition: Competition;
}

export const BID_WINDOW_DAYS = 30;
export const BID_MAX_MARKS = 400;
export const BID_MIN_MARKS = 5;

/**
 * Marks for the bid-window map: open solicitations with a quantity above zero
 * closing within 30 days, soonest first, at most 400. null below 5 marks.
 */
export function buildBidMarks(
  sols: readonly BidSolicitation[],
  today: string
): { marks: BidMark[]; total: number; capped: boolean } | null {
  const eligible: BidMark[] = [];
  for (const s of sols) {
    if (!s.returnBy || !(s.quantity !== null && s.quantity > 0)) continue;
    const days = daysBetween(today, s.returnBy);
    if (days < 0 || days > BID_WINDOW_DAYS) continue;
    eligible.push({ solNumber: s.solNumber, nsn: s.nsn, name: s.name, quantity: s.quantity, days, competition: s.competition });
  }
  if (eligible.length < BID_MIN_MARKS) return null;
  eligible.sort((a, b) => a.days - b.days || a.solNumber.localeCompare(b.solNumber));
  return { marks: eligible.slice(0, BID_MAX_MARKS), total: eligible.length, capped: eligible.length > BID_MAX_MARKS };
}

/** Smallest power of ten strictly above `max` (and at least 10). */
export function powerAbove(max: number): number {
  let p = 10;
  while (p <= max) p *= 10;
  return p;
}

const isRoundStep = (step: number): boolean => {
  if (!Number.isInteger(step) || step < 1) return false;
  let m = step;
  while (m % 10 === 0) m /= 10;
  return m === 1 || m === 2 || m === 5 || m === 25;
};

/**
 * Y axis for a chart of whole counts: the nice maximum at or above `max`, and
 * ticks (from `ticks()`) whose spacing is a round whole number, so a count
 * axis reads 50, 100, 150, 200, 250 rather than 83, 167, 250.
 */
export function countAxis(max: number): { top: number; ticks: number[] } {
  const top = niceMax(Math.ceil(max));
  const n = [4, 5, 2, 3, 1].find((c) => isRoundStep(top / c)) ?? 1;
  return { top, ticks: ticks(top, n) };
}
