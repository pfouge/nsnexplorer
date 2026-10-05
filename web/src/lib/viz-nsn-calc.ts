// viz-nsn-calc.ts — chart 14: the award price calculator. Pure, and shared
// verbatim by the server render (default state) and the small client script
// that recomputes when a window size is chosen, so the two cannot disagree.
import { el, monthYear, svg, text, tip } from './viz.ts';
import { money, supplierLabel, type AwardIn } from './viz-nsn-common.ts';

export const CALC_MAX = 12;
export const MIN_POINTS_CALC = 3;

export interface CalcRow {
  date: string; // ISO
  price: number;
  qty: number | null;
  supplier: string | null;
}

/** The 12 most recent priced awards, newest first. */
export function calcRows(points: AwardIn[]): CalcRow[] {
  return points
    .filter((p) => Number.isFinite(p.unitPrice))
    .sort((a, b) => b.awardedOn.localeCompare(a.awardedOn) || b.id - a.id)
    .slice(0, CALC_MAX)
    .map((p) => ({ date: p.awardedOn, price: p.unitPrice, qty: p.quantity, supplier: supplierLabel(p.supplierName, p.cage) }));
}

export interface CalcOption {
  n: number;
  label: string;
}
/** "Last 3", "Last 5", "Last 10" while they fit, then "All N"; the smallest is the default. */
export function calcOptions(rowCount: number): CalcOption[] {
  const out: CalcOption[] = [];
  for (const n of [3, 5, 10]) if (n < rowCount) out.push({ n, label: `Last ${n}` });
  out.push({ n: rowCount, label: `All ${rowCount}` });
  return out;
}

export interface CalcStats {
  avg: number;
  /** Weighted by quantity over included rows that state one; null when none do. */
  weighted: number | null;
  min: number;
  max: number;
  from: string; // oldest included award
  to: string; // newest included award
}
export function calcStats(rows: CalcRow[], k: number): CalcStats {
  const inc = rows.slice(0, k);
  const prices = inc.map((r) => r.price);
  const wRows = inc.filter((r) => r.qty !== null && r.qty > 0);
  const qSum = wRows.reduce((a, r) => a + r.qty!, 0);
  return {
    avg: prices.reduce((a, b) => a + b, 0) / inc.length,
    weighted: qSum > 0 ? wRows.reduce((a, r) => a + r.price * r.qty!, 0) / qSum : null,
    min: Math.min(...prices),
    max: Math.max(...prices),
    from: inc[inc.length - 1].date,
    to: inc[0].date,
  };
}

export function windowLabel(from: string, to: string): string {
  const a = monthYear(from);
  const b = monthYear(to);
  return a === b ? a : `${a} – ${b}`;
}
export const rangeLabel = (s: CalcStats): string => `${money(s.min)} – ${money(s.max)}`;

const BW = 300;
const BH = 66;
/** The range bar: track over all rows' min..max, the included span, a ring per included award, a marker at the average. */
export function rangeBarSvg(rows: CalcRow[], k: number): string {
  const all = rows.map((r) => r.price);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const x = (p: number): number => (hi === lo ? BW / 2 : 10 + ((p - lo) / (hi - lo)) * (BW - 20));
  const s = calcStats(rows, k);
  const marker = s.weighted ?? s.avg;
  const parts: string[] = [
    el('line', { x1: 10, x2: BW - 10, y1: 38, y2: 38, class: 'vs-grid', 'stroke-width': 6, 'stroke-linecap': 'round' }),
    el('line', { x1: x(s.min), x2: x(s.max), y1: 38, y2: 38, class: 'vs-main', 'stroke-width': 6, 'stroke-linecap': 'round' }),
  ];
  for (const r of rows.slice(0, k)) {
    parts.push(
      el('circle', {
        cx: x(r.price),
        cy: 38,
        r: 4,
        class: 'vf-card vs-main',
        'stroke-width': 2,
        'data-tip': tip(`${money(r.price)} each`, `${r.qty !== null ? `qty ${Math.round(r.qty).toLocaleString('en-US')} · ` : ''}${monthYear(r.date)}`),
      })
    );
  }
  const mx = x(marker);
  parts.push(el('path', { d: `M${mx.toFixed(1)},29l5,-8h-10z`, class: 'vf-ink' }));
  parts.push(text(Math.min(BW - 50, Math.max(50, mx)), 14, s.weighted !== null ? 'weighted average' : 'average', { class: 'vt-ink', 'text-anchor': 'middle' }));
  parts.push(text(10, 62, money(lo)));
  parts.push(text(BW - 10, 62, money(hi), { 'text-anchor': 'end' }));
  return svg(BW, BH, `Range of the ${k} included award prices, ${money(lo)} to ${money(hi)} across the latest ${rows.length}`, parts);
}
