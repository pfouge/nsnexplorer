// lib/viz-supplier.ts — pure model for the supplier page's "Awards by month"
// bar chart: 24 calendar months, award dollars or awards won. No pg, no DOM.

import { fmtInt, fmtUsd } from './viz.ts';
import { countAxis } from './viz-open.ts';

export interface MonthInput {
  /** 'YYYY-MM' */
  month: string;
  awards: number;
  dollars: number;
}

export type MonthMode = 'dollars' | 'awards';

export interface MonthBar {
  month: string;
  /** 'Oct 2026' */
  label: string;
  awards: number;
  dollars: number;
  /** Value plotted in this mode. */
  value: number;
}

export interface MonthsModel {
  mode: MonthMode;
  bars: MonthBar[];
  /** Axis top (a "nice" number at or above the tallest bar). */
  top: number;
  ticks: number[];
  /** Month label positions: bar index + text, every third month and always the last. */
  labels: { i: number; text: string }[];
}

/** A chart needs awards in at least this many of the months, else the section shows the table-free sentence only. */
export const MIN_MONTHS_WITH_AWARDS = 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** True when there is something worth drawing. */
export function chartable(months: MonthInput[]): boolean {
  return months.filter((m) => m.awards > 0).length >= MIN_MONTHS_WITH_AWARDS;
}

/** Dollar mode needs at least two months with a dollar value; otherwise awards are the honest measure. */
export function defaultMode(months: MonthInput[]): MonthMode {
  return months.filter((m) => m.dollars > 0).length >= 2 ? 'dollars' : 'awards';
}

export function buildMonths(months: MonthInput[], mode: MonthMode): MonthsModel {
  const bars: MonthBar[] = months.map((m) => ({
    month: m.month,
    label: monthLabel(m.month),
    awards: m.awards,
    dollars: m.dollars,
    value: mode === 'dollars' ? m.dollars : m.awards,
  }));
  const max = Math.max(0, ...bars.map((b) => b.value));
  const axis = countAxis(max); // round steps (1/2/5 x 10^n) that divide the top evenly
  const labels = bars.flatMap((b, i) => {
    const fromEnd = bars.length - 1 - i;
    return fromEnd % 3 === 0 ? [{ i, text: `${b.label.slice(0, 3)}${b.month.slice(5, 7) === '01' || i === 0 ? ` ${b.month.slice(2, 4)}` : ''}` }] : [];
  });
  return { mode, bars, top: axis.top, ticks: axis.ticks, labels };
}

export const axisLabel = (mode: MonthMode, v: number): string => (mode === 'dollars' ? fmtUsd(v) : fmtInt(v));

export function barTip(b: MonthBar): [string, string] {
  const awards = `${fmtInt(b.awards)} ${b.awards === 1 ? 'award' : 'awards'}`;
  return [b.label, b.dollars > 0 ? `${awards}, ${fmtUsd(b.dollars)} recorded` : awards];
}
