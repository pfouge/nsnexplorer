// lib/viz-class.ts — pure number-crunching for the "Market view" charts on a
// supply class page: competition mix, most re-bought items, demand trend,
// who wins, and where the winning suppliers are. No pg, no DOM.

import { STATE_TILES, daysBetween, fmtInt, monthDay, monthYear } from './viz.ts';
import { addDays } from './viz-open.ts';

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- 07 competition mix

export interface CompetitionInput {
  fsc: string;
  /** label shown at the left, e.g. '5340 Hardware, Commercial' */
  label: string;
  open: number;
  restricted: number;
  unknown: number;
}
export interface CompetitionRow extends CompetitionInput {
  total: number;
  focus: boolean;
  openPct: number;
  segments: { key: 'open' | 'restricted' | 'unknown'; label: string; count: number; pct: number }[];
}

export const COMPETITION_LABELS = { open: 'Open competition', restricted: 'Restricted to listed sources', unknown: 'Not coded' } as const;
export const COMPETITION_OTHER_CLASSES = 5;

/**
 * Rows for the competition mix: the focus class first, then up to five other
 * classes of the same group (callers pass them largest-first). null when the
 * focus class has no coded NSN at all.
 */
export function buildCompetitionRows(focus: CompetitionInput, others: CompetitionInput[]): CompetitionRow[] | null {
  if (focus.open + focus.restricted < 1) return null;
  const make = (r: CompetitionInput, isFocus: boolean): CompetitionRow => {
    const total = r.open + r.restricted + r.unknown;
    const segs = (['open', 'restricted', 'unknown'] as const).map((key) => ({
      key,
      label: COMPETITION_LABELS[key],
      count: r[key],
      pct: pct(r[key], total),
    }));
    return { ...r, total, focus: isFocus, openPct: pct(r.open, total), segments: segs };
  };
  const rows = [make(focus, true)];
  for (const o of others.filter((x) => x.fsc !== focus.fsc && x.open + x.restricted + x.unknown > 0).slice(0, COMPETITION_OTHER_CLASSES)) rows.push(make(o, false));
  return rows;
}

// ---------------------------------------------------------------- 08 most re-bought

export interface RepeatRow {
  nsn: string; // dashed
  name: string;
  solicitations: number;
  quantity: number;
}
export interface RepeatModel {
  byCount: RepeatRow[];
  byQty: RepeatRow[];
  note: string;
}
export const REPEAT_TOP = 7;
export const REPEAT_MIN_ITEMS = 2;

/**
 * Two ranked panels. Eligible items have at least 2 solicitations in the
 * last 12 months; the chart needs at least 2 such items. `earliest` is the
 * earliest solicitation on record anywhere (ISO) and `today` the build date.
 */
export function buildRepeat(rows: RepeatRow[], earliest: string | null, today: string): RepeatModel | null {
  const eligible = rows.filter((r) => r.solicitations >= 2);
  if (eligible.length < REPEAT_MIN_ITEMS) return null;
  const byCount = [...eligible]
    .sort((a, b) => b.solicitations - a.solicitations || b.quantity - a.quantity || a.nsn.localeCompare(b.nsn))
    .slice(0, REPEAT_TOP);
  const byQty = [...eligible]
    .filter((r) => r.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity || b.solicitations - a.solicitations || a.nsn.localeCompare(b.nsn))
    .slice(0, REPEAT_TOP);
  let note = 'Counts every solicitation recorded for the item in the last 12 months.';
  if (earliest && daysBetween(earliest, today) < 365) note += ` Solicitations have been tracked since ${monthYear(earliest)}.`;
  return { byCount, byQty, note };
}

export const repeatValueLabel = (row: RepeatRow, mode: 'count' | 'qty'): string =>
  mode === 'count' ? plural(row.solicitations, 'solicitation') : `${fmtInt(row.quantity)} ${row.quantity === 1 ? 'unit' : 'units'}`;

// ---------------------------------------------------------------- 09 demand trend

export interface WeekCount {
  /** Monday of the week, ISO */
  week: string;
  n: number;
}
export interface WeeklyModel {
  weeks: WeekCount[];
  /** 8-week trailing average per week, null until 8 weeks exist */
  avg: (number | null)[] | null;
  max: number;
  /** indices of weeks that carry a month label, with the label */
  monthLabels: { i: number; label: string }[];
  note: string;
}

export const TREND_WEEKS = 52;
export const TREND_AVG_WINDOW = 8;
export const TREND_AVG_MIN_WEEKS = 12;
export const TREND_MIN_ACTIVE_WEEKS = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday on or before `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

export const fmtAvg = (n: number): string => (n >= 10 ? fmtInt(n) : String(Math.round(n * 10) / 10));

/**
 * Weekly series for up to the 52 most recent COMPLETE weeks (Monday weeks;
 * the running week is left out), zero-filled, starting no earlier than the
 * first fully tracked week (`earliest` is the earliest solicitation on record
 * anywhere). null below 4 weeks with at least one solicitation.
 */
export function buildWeekly(rows: WeekCount[], today: string, earliest: string | null): WeeklyModel | null {
  const thisMonday = mondayOf(today);
  const lastComplete = addDays(thisMonday, -7);
  let start = addDays(thisMonday, -7 * TREND_WEEKS);
  if (earliest) {
    const firstFull = mondayOf(earliest) === earliest ? earliest : addDays(mondayOf(earliest), 7);
    if (firstFull > start) start = firstFull;
  }
  if (start > lastComplete) return null;
  const byWeek = new Map(rows.map((r) => [r.week, r.n]));
  const weeks: WeekCount[] = [];
  for (let w = start; w <= lastComplete; w = addDays(w, 7)) weeks.push({ week: w, n: byWeek.get(w) ?? 0 });
  if (weeks.filter((w) => w.n > 0).length < TREND_MIN_ACTIVE_WEEKS) return null;

  const hasAvg = weeks.length >= TREND_AVG_MIN_WEEKS;
  const avg = hasAvg
    ? weeks.map((_, i) =>
        i < TREND_AVG_WINDOW - 1 ? null : weeks.slice(i - TREND_AVG_WINDOW + 1, i + 1).reduce((a, w) => a + w.n, 0) / TREND_AVG_WINDOW
      )
    : null;

  // Month names where a new month starts; the first bar is labelled only when
  // the next label is far enough away not to collide.
  const starts: number[] = [];
  weeks.forEach((w, i) => {
    if (i > 0 && w.week.slice(5, 7) !== weeks[i - 1].week.slice(5, 7)) starts.push(i);
  });
  const idx = starts.length === 0 || starts[0] >= 4 ? [0, ...starts] : starts;
  const monthLabels = idx.map((i) => ({ i, label: MONTHS[Number(weeks[i].week.slice(5, 7)) - 1] }));

  const latest = weeks[weeks.length - 1];
  let note = `In the week of ${monthDay(latest.week)}, ${latest.n === 1 ? '1 solicitation was' : `${fmtInt(latest.n)} solicitations were`} posted.`;
  const lastAvg = avg ? avg[avg.length - 1] : null;
  if (lastAvg !== null) note += ` The 8-week average is ${fmtAvg(lastAvg)}.`;
  if (weeks.length < TREND_WEEKS && earliest) note += ` Solicitations have been tracked since ${monthYear(earliest)}.`;
  return { weeks, avg, max: Math.max(...weeks.map((w) => w.n), ...((avg ?? []).filter((v): v is number => v !== null))), monthLabels, note };
}

// ---------------------------------------------------------------- 10 who wins

export interface WinnerRow {
  label: string;
  amount: number;
}
export interface WinnersInput {
  /** top suppliers by award dollars, largest first (at least the top 6) */
  top: WinnerRow[];
  /** every supplier counted, and the dollars across all of them */
  suppliers: number;
  total: number;
}
export interface WinnerBar {
  label: string;
  amount: number;
  pct: number;
  other: boolean;
}
export const WINNERS_TOP = 6;
export const WINNERS_MIN_SUPPLIERS = 3;

export function buildWinners(input: WinnersInput): { bars: WinnerBar[]; topThreePct: number } | null {
  if (input.suppliers < WINNERS_MIN_SUPPLIERS || !(input.total > 0)) return null;
  const top = input.top.slice(0, WINNERS_TOP);
  const bars: WinnerBar[] = top.map((r) => ({ label: r.label, amount: r.amount, pct: pct(r.amount, input.total), other: false }));
  const restN = input.suppliers - top.length;
  if (restN > 0) {
    const rest = Math.max(0, input.total - top.reduce((a, r) => a + r.amount, 0));
    bars.push({ label: `All other suppliers (${fmtInt(restN)})`, amount: rest, pct: pct(rest, input.total), other: true });
  }
  const topThree = top.slice(0, 3).reduce((a, r) => a + r.amount, 0);
  return { bars, topThreePct: pct(topThree, input.total) };
}

// ---------------------------------------------------------------- 11 supplier map

export interface StateCount {
  /** upper-case state code, or null when the supplier has none on file */
  state: string | null;
  suppliers: number;
  amount: number;
}
export interface StateMapModel {
  byState: Map<string, { suppliers: number; amount: number }>;
  max: number;
  withState: number;
  missing: number;
  note: string;
}
export const STATE_MAP_MIN = 5;
const TILE_CODES = new Set(STATE_TILES.map((t) => t[0]));

export function buildStateMap(rows: StateCount[]): StateMapModel | null {
  const byState = new Map<string, { suppliers: number; amount: number }>();
  let withState = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.state && TILE_CODES.has(r.state)) {
      const cur = byState.get(r.state) ?? { suppliers: 0, amount: 0 };
      cur.suppliers += r.suppliers;
      cur.amount += r.amount;
      byState.set(r.state, cur);
      withState += r.suppliers;
    } else missing += r.suppliers;
  }
  if (withState < STATE_MAP_MIN) return null;
  let note = 'From supplier addresses in the federal CAGE file.';
  if (missing > 0) note += ` ${plural(missing, 'supplier')} ${missing === 1 ? 'has' : 'have'} no U.S. state on file.`;
  return { byState, max: Math.max(...[...byState.values()].map((v) => v.suppliers)), withState, missing, note };
}
