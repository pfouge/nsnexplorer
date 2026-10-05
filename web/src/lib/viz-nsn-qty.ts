// viz-nsn-qty.ts — chart 13: unit price against order quantity (log x), an
// optional least-squares trend, and the open solicitation's quantity band.
import { MIN_POINTS_QTY_CURVE, el, linear, log10, monthYear, svg, text, tip } from './viz.ts';
import { axisFor, fmtAxisPrice, money, plural, supplierLabel, type AwardIn, type SolIn } from './viz-nsn-common.ts';
import type { LegendItem } from './viz-nsn-price.ts';

export const BAND_FACTOR = 1.8;
export const MIN_POINTS_TREND = 8;

export const withQty = (points: AwardIn[]): AwardIn[] => points.filter((p) => p.quantity !== null && p.quantity > 0 && Number.isFinite(p.unitPrice));

export function qtyEligible(points: AwardIn[]): boolean {
  const q = withQty(points);
  return q.length >= MIN_POINTS_QTY_CURVE && new Set(q.map((p) => p.quantity)).size >= 3;
}

/** Least-squares fit of price on log10(quantity); null with fewer than 8 points or no spread. */
export function trendFit(points: AwardIn[]): { slope: number; intercept: number } | null {
  const q = withQty(points);
  if (q.length < MIN_POINTS_TREND) return null;
  const xs = q.map((p) => Math.log10(p.quantity!));
  const ys = q.map((p) => p.unitPrice);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** The soonest-closing open solicitation that states a quantity (no return date sorts last). */
export function soonestOpen(sols: SolIn[]): SolIn | null {
  const open = sols.filter((s) => s.status === 'open' && s.quantity !== null && s.quantity > 0);
  open.sort((a, b) => (a.returnBy ?? '9999-12-31').localeCompare(b.returnBy ?? '9999-12-31') || a.solNumber.localeCompare(b.solNumber));
  return open[0] ?? null;
}

export const bandOf = (n: number): { lo: number; hi: number } => ({ lo: n / BAND_FACTOR, hi: n * BAND_FACTOR });

/** Awards whose quantity falls inside the band around n, newest first. */
export function nearAwards(points: AwardIn[], n: number): AwardIn[] {
  const { lo, hi } = bandOf(n);
  return withQty(points)
    .filter((p) => p.quantity! >= lo && p.quantity! <= hi)
    .sort((a, b) => b.awardedOn.localeCompare(a.awardedOn) || b.id - a.id);
}

/** Round x-axis labels (1, 2, 5 x 10^k) inside [lo, hi], thinned to at most 7. */
export function logTicks(lo: number, hi: number): number[] {
  for (const mults of [[1, 2, 5], [1, 5], [1]]) {
    const out: number[] = [];
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (const m of mults) {
        const v = m * 10 ** k;
        if (v >= lo && v <= hi) out.push(v);
      }
    }
    if (out.length <= 7) return out;
  }
  return [];
}

/** Part of the line y = f(lq) over [a, b] that stays within [0, top], or null. */
export function clipLine(a: number, b: number, f: (lq: number) => number, top: number): [number, number, number, number] | null {
  const ya = f(a);
  const yb = f(b);
  const dy = yb - ya;
  if (dy === 0) return ya >= 0 && ya <= top ? [a, ya, b, yb] : null;
  const tA = (0 - ya) / dy;
  const tB = (top - ya) / dy;
  const t0 = Math.max(0, Math.min(tA, tB));
  const t1 = Math.min(1, Math.max(tA, tB));
  if (t0 > t1) return null;
  return [a + (b - a) * t0, ya + dy * t0, a + (b - a) * t1, ya + dy * t1];
}

export interface QtyModel {
  svg: string;
  legend: LegendItem[];
  question: string;
  note: string;
  openQty: number | null;
  /** Up to 8 awards inside the band, newest first (the table beside the chart). */
  near: AwardIn[];
  nearCount: number;
  hasTrend: boolean;
}

const W = 560;
const H = 270;

export function buildPriceByQty(points: AwardIn[], sols: SolIn[]): QtyModel | null {
  if (!qtyEligible(points)) return null;
  const pts = withQty(points);
  const open = soonestOpen(sols);
  const N = open?.quantity ?? null;
  const axis = axisFor(Math.max(...pts.map((p) => p.unitPrice)) || 1);
  const left = Math.max(50, Math.max(...axis.values.map((v) => fmtAxisPrice(v, axis.step).length)) * 6.6 + 12);
  const right = 14;
  const topPad = 26;
  const base = H - 38;
  const qs = pts.map((p) => p.quantity!);
  const lo = Math.max(1, Math.min(...qs, ...(N ? [bandOf(N).lo] : [])) / 1.3);
  const hi = Math.max(...qs, ...(N ? [bandOf(N).hi] : [])) * 1.3;
  const x = log10(lo, hi, left, W - right);
  const y = linear(0, axis.top, base, topPad);

  const parts: string[] = [];
  for (const v of axis.values) {
    parts.push(el('line', { x1: left, x2: W - right, y1: y(v), y2: y(v), class: 'vs-grid' }));
    parts.push(text(left - 6, y(v) + 4, fmtAxisPrice(v, axis.step), { 'text-anchor': 'end' }));
  }
  parts.push(text(left - 6, base + 4, '$0', { 'text-anchor': 'end' }));
  parts.push(el('line', { x1: left, x2: W - right, y1: base, y2: base, class: 'vs-axis' }));
  for (const t of logTicks(lo, hi)) {
    parts.push(el('line', { x1: x(t), x2: x(t), y1: base, y2: base + 5, class: 'vs-axis' }));
    parts.push(text(x(t), base + 18, Math.round(t).toLocaleString('en-US'), { 'text-anchor': 'middle' }));
  }
  parts.push(text((left + W - right) / 2, H - 4, 'award quantity (log scale)', { 'text-anchor': 'middle' }));
  parts.push(text(left, 12, 'unit price'));

  let near: AwardIn[] = [];
  if (N !== null) {
    const b = bandOf(N);
    parts.push(el('rect', { x: x(b.lo), y: topPad, width: x(b.hi) - x(b.lo), height: base - topPad, class: 'vf-band' }));
    parts.push(el('line', { x1: x(N), x2: x(N), y1: topPad, y2: base, class: 'vs-ink', 'stroke-width': 1.5 }));
    const flip = x(N) > W * 0.62;
    parts.push(text(flip ? x(N) - 6 : x(N) + 6, topPad + 12, `open solicitation: qty ${Math.round(N).toLocaleString('en-US')}`, { class: 'vt-ink vt-b vt-halo', 'text-anchor': flip ? 'end' : null }));
    near = nearAwards(points, N);
  }

  const fit = trendFit(points);
  if (fit) {
    const f = (lq: number): number => fit.intercept + fit.slope * lq;
    const seg = clipLine(Math.log10(Math.min(...qs)), Math.log10(Math.max(...qs)), f, axis.top);
    if (seg) {
      parts.push(
        el('path', {
          d: `M${x(10 ** seg[0]).toFixed(1)},${y(seg[1]).toFixed(1)}L${x(10 ** seg[2]).toFixed(1)},${y(seg[3]).toFixed(1)}`,
          class: 'vf-none vs-axis',
          'stroke-width': 2,
          'stroke-dasharray': '5 4',
        })
      );
    }
  }

  const focusable = pts.length < 40;
  let anyFlag = false;
  for (const p of pts) {
    const flagged = p.spikeRatio !== null;
    anyFlag ||= flagged;
    const sup = supplierLabel(p.supplierName, p.cage);
    parts.push(
      el('circle', {
        cx: x(p.quantity!),
        cy: y(p.unitPrice),
        r: 5,
        class: `${flagged ? 'vf-flag' : 'vf-main'} vring`,
        'fill-opacity': 0.85,
        'data-tip': tip(`${money(p.unitPrice)} each`, `qty ${Math.round(p.quantity!).toLocaleString('en-US')} · ${monthYear(p.awardedOn)}`, sup, flagged && `${p.spikeRatio!.toFixed(1)}× the median`),
        tabindex: focusable ? 0 : null,
      })
    );
  }

  let note: string;
  if (N === null) note = 'No solicitation is open for this item right now.';
  else if (near.length === 0) note = `No past award was near ${Math.round(N).toLocaleString('en-US')} units.`;
  else {
    const b = bandOf(N);
    const ps = near.map((p) => p.unitPrice);
    const mn = Math.min(...ps);
    const mx = Math.max(...ps);
    note =
      `${near.length} past ${plural(near.length, 'award was', 'awards were')} between ${Math.ceil(b.lo).toLocaleString('en-US')} and ${Math.floor(b.hi).toLocaleString('en-US')} units, ` +
      `at ${mn === mx ? `${money(mn)} each` : `${money(mn)} to ${money(mx)} each`}.`;
  }
  const legend: LegendItem[] = [{ key: 'main', label: 'Award' }];
  if (anyFlag) legend.push({ key: 'flag', label: 'Far above the typical range' });
  return {
    svg: svg(W, H, `Unit price against award quantity, ${pts.length} awards`, parts),
    legend,
    question: "How does the price change with quantity, and what did past awards near an open solicitation's quantity pay?",
    note,
    openQty: N,
    near: near.slice(0, 8),
    nearCount: near.length,
    hasTrend: fit !== null,
  };
}
