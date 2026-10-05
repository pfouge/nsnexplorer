// viz-nsn-price.ts — chart 12: every award as a dot (size = quantity) over a
// shaded middle-half price band. Flagged dots are the ones the existing
// withSpikeRatios() rule marks (>= 3x trailing median), so this chart and the
// purchase table's highlighted rows always agree.
import { MIN_POINTS_PRICE, el, linear, monthYear, quantile, svg, text, tip, type Attrs } from './viz.ts';
import { axisFor, dateTicks, fmtAxisPrice, money, plural, safeUrl, supplierLabel, timeDomain, isoMs, type AwardIn } from './viz-nsn-common.ts';

export interface LegendItem {
  key: string;
  label: string;
  shape?: string;
}

export interface PriceHistoryModel {
  svg: string;
  legend: LegendItem[];
  question: string;
  note: string;
  q1: number;
  median: number;
  q3: number;
  count: number;
  flagged: number;
}

export const dotRadius = (qty: number | null): number => (qty && qty > 0 ? 3.5 + 2.4 * Math.log10(Math.max(1, qty)) : 3.5);

const W = 1160;
const H = 300;

export function buildPriceHistory(points: AwardIn[], todayIso: string): PriceHistoryModel | null {
  const pts = points.filter((p) => Number.isFinite(p.unitPrice)).sort((a, b) => a.awardedOn.localeCompare(b.awardedOn) || a.id - b.id);
  if (pts.length < MIN_POINTS_PRICE) return null;

  const sortedPrices = pts.map((p) => p.unitPrice).sort((a, b) => a - b);
  const q1 = quantile(sortedPrices, 0.25);
  const med = quantile(sortedPrices, 0.5);
  const q3 = quantile(sortedPrices, 0.75);
  const axis = axisFor(sortedPrices[sortedPrices.length - 1] || 1);
  const left = Math.max(56, Math.max(...axis.values.map((v) => fmtAxisPrice(v, axis.step).length)) * 6.6 + 14);
  const right = 20;
  const topPad = 24;
  const base = H - 36;
  const { t0, t1 } = timeDomain(pts[0].awardedOn, pts[pts.length - 1].awardedOn, todayIso);
  const x = linear(t0, t1, left + 12, W - right - 12);
  const y = linear(0, axis.top, base, topPad);

  const parts: string[] = [];
  for (const v of axis.values) {
    parts.push(el('line', { x1: left, x2: W - right, y1: y(v), y2: y(v), class: 'vs-grid' }));
    parts.push(text(left - 6, y(v) + 4, fmtAxisPrice(v, axis.step), { 'text-anchor': 'end' }));
  }
  parts.push(text(left - 6, base + 4, '$0', { 'text-anchor': 'end' }));
  // The typical range: middle half of all prices, dashed median.
  const bandTop = y(q3);
  const bandH = Math.max(2, y(q1) - y(q3));
  parts.push(el('rect', { x: left, y: bandTop, width: W - right - left, height: bandH, class: 'vf-band' }));
  parts.push(el('line', { x1: left, x2: W - right, y1: y(med), y2: y(med), class: 'vs-axis', 'stroke-dasharray': '4 4' }));
  // The label goes at the first spot (above the band, then higher, then below it) where no dot overlaps it.
  const labelText = `median ${money(med)}, middle half shaded`;
  const lw = labelText.length * 6.4 + 8;
  const px = pts.map((p) => ({ cx: x(isoMs(p.awardedOn)), cy: y(p.unitPrice), r: dotRadius(p.quantity) }));
  const blocked = (lx: number, ly: number): boolean => px.some((d) => d.cx + d.r > lx && d.cx - d.r < lx + lw && d.cy + d.r > ly - 12 && d.cy - d.r < ly + 4);
  const ys = [bandTop - 7, bandTop - 24, bandTop + bandH + 16].filter((v) => v >= 12 && v <= base - 6);
  let labelX = left + 4;
  let labelY = ys[0] ?? bandTop + bandH + 14;
  search: for (const ly of ys) {
    for (let c = left + 4; c + lw <= W - right; c += 10) {
      if (!blocked(c, ly)) {
        labelX = c;
        labelY = ly;
        break search;
      }
    }
  }
  parts.push(text(labelX, labelY, labelText, { class: 'vt-ink vt-b vt-halo' }));
  parts.push(el('line', { x1: left, x2: W - right, y1: base, y2: base, class: 'vs-axis' }));
  for (const t of dateTicks(t0, t1)) {
    parts.push(el('line', { x1: x(t.t), x2: x(t.t), y1: base, y2: base + 6, class: 'vs-axis' }));
    parts.push(text(x(t.t), H - 14, t.label, { 'text-anchor': 'middle' }));
  }

  const flaggedPts = pts.filter((p) => p.spikeRatio !== null);
  const labelled = new Set([...flaggedPts].sort((a, b) => (b.spikeRatio ?? 0) - (a.spikeRatio ?? 0)).slice(0, 3).map((p) => p.id));
  const focusable = pts.length < 40;
  // Big dots first so small ones stay on top.
  const draw = [...pts].sort((a, b) => dotRadius(b.quantity) - dotRadius(a.quantity));
  const labels: string[] = [];
  for (const p of draw) {
    const cx = x(isoMs(p.awardedOn));
    const cy = y(p.unitPrice);
    const r = dotRadius(p.quantity);
    const flagged = p.spikeRatio !== null;
    const when = monthYear(p.awardedOn);
    const lines = [
      `${money(p.unitPrice)} each`,
      p.quantity !== null ? `qty ${Math.round(p.quantity).toLocaleString('en-US')} · ${when}` : when,
      supplierLabel(p.supplierName, p.cage),
      flagged && `${p.spikeRatio!.toFixed(1)}× the median`,
    ];
    const href = safeUrl(p.sourceUrl);
    const circle = el('circle', { cx, cy, r, class: `${flagged ? 'vf-flag' : 'vf-main'} vring`, 'fill-opacity': 0.85 });
    const a: Attrs = { 'data-tip': tip(...lines), 'aria-label': lines.filter(Boolean).join(', ') };
    parts.push(
      href
        ? el('a', { href, target: '_blank', rel: 'nofollow noopener', ...a }, circle)
        : el('g', { ...a, tabindex: focusable ? 0 : null }, circle)
    );
    if (labelled.has(p.id)) {
      const flip = cx > W - 130;
      labels.push(
        text(flip ? cx - r - 5 : cx + r + 5, cy + 4, `${p.spikeRatio!.toFixed(1)}× median`, { class: 'vt-ink vt-b vt-halo', 'text-anchor': flip ? 'end' : null })
      );
    }
  }
  parts.push(...labels);

  const nFlag = flaggedPts.length;
  const legend: LegendItem[] = [{ key: 'main', label: 'Award (bigger dot, bigger quantity)' }];
  if (nFlag > 0) legend.push({ key: 'flag', label: 'Far above the typical range' });
  legend.push({ key: 'band', label: 'Middle half of prices' });

  const first = monthYear(pts[0].awardedOn);
  const last = monthYear(pts[pts.length - 1].awardedOn);
  return {
    svg: svg(W, H, `Unit price of each of ${pts.length} awards, ${first} to ${last}`, parts),
    legend,
    question: `What has the government paid for this item, and was any award out of line? Every award as a dot, ${first} to today.`,
    note:
      `Most awards fall between ${money(q1)} and ${money(q3)}.` +
      (nFlag > 0 ? ` ${nFlag} ${plural(nFlag, 'award')} ran well above that range and ${nFlag === 1 ? 'is' : 'are'} marked.` : ''),
    q1,
    median: med,
    q3,
    count: pts.length,
    flagged: nFlag,
  };
}
