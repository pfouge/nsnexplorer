// viz-nsn-common.ts — pure helpers shared by the NSN-page charts (no DOM, no pg).
// Imports use explicit .ts extensions so `node --test` can load them directly.
import { fmtPrice, monthYear, niceMax, ticks } from './viz.ts';

/** Fields the NSN charts read from a priced award (structurally a PointWithSpike). */
export interface AwardIn {
  id: number;
  awardedOn: string;
  unitPrice: number;
  quantity: number | null;
  cage: string | null;
  supplierName: string | null;
  sourceUrl: string;
  solNumber: string | null;
  /** Set by withSpikeRatios (>= 3x trailing median); the one definition of "flagged". */
  spikeRatio: number | null;
}

/** Fields the NSN charts read from a solicitation. */
export interface SolIn {
  solNumber: string;
  issuedOn: string | null;
  returnBy: string | null;
  quantity: number | null;
  status: string;
}

export const DAY = 86400000;
export const isoMs = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Unit price as text: cents above 10 cents, up to 4 decimals below. */
export function money(v: number): string {
  if (v > 0 && v < 0.1) {
    let s = v.toFixed(4).replace(/0+$/, '');
    const dp = s.length - s.indexOf('.') - 1;
    if (dp < 2) s += '0'.repeat(2 - dp);
    return `$${s}`;
  }
  return fmtPrice(v);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' -> 'Oct 5, 2026'. */
export function fmtDay(iso: string): string {
  return `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

/** Plain-text name for a supplier: its name, else `CAGE XXXXX`, else null. */
export function supplierLabel(name: string | null | undefined, cage: string | null | undefined): string | null {
  const n = name?.trim();
  if (n) return n;
  return cage ? `CAGE ${cage.trim()}` : null;
}

/** http(s) links only: source URLs are government data and must never become javascript: links. */
export function safeUrl(u: string | null | undefined): string | null {
  return u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

export interface TimeDomain {
  t0: number;
  t1: number;
}
/** First event to today, never less than 12 months wide. */
export function timeDomain(firstIso: string, lastIso: string, todayIso: string): TimeDomain {
  const t1 = Math.max(isoMs(todayIso), isoMs(lastIso));
  let t0 = Math.min(isoMs(firstIso), t1);
  if (t1 - t0 < 365 * DAY) t0 = t1 - 365 * DAY;
  return { t0, t1 };
}

export interface DateTick {
  t: number;
  label: string;
}
/** January of each year ('Jan 2024'); quarter starts when the span is under 18 months. */
export function dateTicks(t0: number, t1: number): DateTick[] {
  const out: DateTick[] = [];
  const spanMonths = (t1 - t0) / (30.4375 * DAY);
  const start = new Date(t0);
  if (spanMonths < 18) {
    for (let y = start.getUTCFullYear(); y <= new Date(t1).getUTCFullYear(); y++) {
      for (const m of [0, 3, 6, 9]) {
        const t = Date.UTC(y, m, 1);
        if (t >= t0 && t <= t1) out.push({ t, label: `${MON[m]} ${y}` });
      }
    }
    return out;
  }
  for (let y = start.getUTCFullYear(); y <= new Date(t1).getUTCFullYear(); y++) {
    const t = Date.UTC(y, 0, 1);
    if (t >= t0 && t <= t1) out.push({ t, label: `Jan ${y}` });
  }
  const keep = Math.ceil(out.length / 12);
  return keep > 1 ? out.filter((_, i) => i % keep === 0) : out;
}

/** Number of tick steps that lands on round values for a niceMax top (1, 2, 2.5, 5 x 10^n). */
export function tickCount(top: number): number {
  const m = top / 10 ** Math.floor(Math.log10(top));
  return m < 2.25 ? 4 : 5;
}
export interface Axis {
  top: number;
  values: number[];
  step: number;
}
/** Axis from 0 to niceMax(max) with round gridline values (0 excluded). */
export function axisFor(max: number): Axis {
  const top = niceMax(max);
  const values = ticks(max, tickCount(top));
  return { top, values, step: values[0] };
}
/** Dollar tick label that shows only the decimals the step needs. */
export function fmtAxisPrice(v: number, step: number): string {
  if (step >= 1) return `$${Math.round(v).toLocaleString('en-US')}`;
  const dp = Math.min(4, Math.max(2, Math.ceil(-Math.log10(step) - 1e-9)));
  return `$${v.toFixed(dp)}`;
}

/** 'Oct 2026' for the month-year label used in tips and tables. */
export const monthLabel = (iso: string): string => monthYear(iso);
