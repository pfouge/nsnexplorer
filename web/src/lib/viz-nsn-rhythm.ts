// viz-nsn-rhythm.ts — chart 15: every solicitation and award for one item on
// a single timeline. Describes history only: no projection of the next buy.
import { MIN_BUYS_RHYTHM, daysBetween, el, median, monthYear, svg, text, tip, type Attrs } from './viz.ts';
import { dateTicks, fmtDay, isoMs, plural, timeDomain, type SolIn } from './viz-nsn-common.ts';
import type { LegendItem } from './viz-nsn-price.ts';

export const BUY_WINDOW_DAYS = 14;

export interface Buy {
  first: string; // first issue date
  last: string;
  qty: number | null; // summed over the buy's solicitations that state one
  solNumbers: string[];
}

/** Solicitations whose issue dates chain within 14 days of each other form one buy. */
export function groupBuys(sols: SolIn[]): Buy[] {
  const dated = sols.filter((s) => s.issuedOn).sort((a, b) => a.issuedOn!.localeCompare(b.issuedOn!) || a.solNumber.localeCompare(b.solNumber));
  const buys: Buy[] = [];
  for (const s of dated) {
    const cur = buys[buys.length - 1];
    if (cur && daysBetween(cur.last, s.issuedOn!) <= BUY_WINDOW_DAYS) {
      cur.last = s.issuedOn!;
      cur.solNumbers.push(s.solNumber);
      if (s.quantity !== null) cur.qty = (cur.qty ?? 0) + s.quantity;
    } else {
      buys.push({ first: s.issuedOn!, last: s.issuedOn!, qty: s.quantity, solNumbers: [s.solNumber] });
    }
  }
  return buys;
}

export interface AwardEvent {
  date: string;
  quantity: number | null;
  supplier: string | null;
  solNumber: string | null;
}

export interface Cadence {
  buys: number;
  since: string; // ISO date of the first buy
  /** Median gap between consecutive buys, in months, or in weeks when under two months. */
  gap: number;
  unit: 'month' | 'week';
  daysSinceLast: number;
}
export function cadence(buys: Buy[], sols: SolIn[], todayIso: string): Cadence {
  const gapsDays = buys.slice(1).map((b, i) => daysBetween(buys[i].first, b.first));
  const medDays = median(gapsDays);
  const months = medDays / 30.4375;
  const lastIssued = sols.filter((s) => s.issuedOn).map((s) => s.issuedOn!).sort().at(-1) ?? buys[buys.length - 1].first;
  return {
    buys: buys.length,
    since: buys[0].first,
    gap: months < 2 ? medDays / 7 : months,
    unit: months < 2 ? 'week' : 'month',
    daysSinceLast: Math.max(0, daysBetween(lastIssued, todayIso)),
  };
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);
export const eventRadius = (qty: number | null): number => Math.min(14, 4 + Math.sqrt(qty && qty > 0 ? qty : 0) / 6);

export interface RhythmModel {
  svg: string;
  legend: LegendItem[];
  question: string;
  note: string;
  headline: string;
  lastLine: string;
  buys: number;
  awards: number;
}

const W = 1160;
const H = 150;
const AX = 80;

export function buildBuyingRhythm(sols: SolIn[], awards: AwardEvent[], todayIso: string): RhythmModel | null {
  const buys = groupBuys(sols);
  if (buys.length < MIN_BUYS_RHYTHM) return null;
  const cad = cadence(buys, sols, todayIso);
  const dates = [...buys.map((b) => b.first), ...awards.map((a) => a.date)].sort();
  const { t0, t1 } = timeDomain(dates[0], dates[dates.length - 1], todayIso);
  const x = (iso: string): number => 40 + ((isoMs(iso) - t0) / (t1 - t0)) * (W - 80);
  const gapText = `${r1(cad.gap)} ${cad.unit === 'week' ? plural(Number(r1(cad.gap)), 'week') : plural(Number(r1(cad.gap)), 'month')}`;
  const headline = `Solicited ${cad.buys} times since ${monthYear(cad.since)}, typically every ${gapText}.`;
  const lastLine =
    cad.daysSinceLast === 0 ? 'Last solicitation today.' : `Last solicitation ${cad.daysSinceLast.toLocaleString('en-US')} ${plural(cad.daysSinceLast, 'day')} ago.`;

  const parts: string[] = [
    text(40, 24, headline, { class: 'vt-ink vt-b vt-lg' }),
    text(40, 42, lastLine, { class: 'vt-ink vt-lg' }),
    el('line', { x1: 40, x2: W - 40, y1: AX, y2: AX, class: 'vs-axis' }),
  ];
  for (const t of dateTicks(t0, t1)) {
    const tx = 40 + ((t.t - t0) / (t1 - t0)) * (W - 80);
    parts.push(el('line', { x1: tx, x2: tx, y1: AX - 6, y2: AX + 6, class: 'vs-axis' }));
    parts.push(text(tx, H - 8, t.label, { 'text-anchor': 'middle' }));
  }

  const focusable = buys.length + awards.length < 40;
  const bySol = new Map<string, Buy>();
  for (const b of buys) for (const n of b.solNumbers) bySol.set(n, b);
  // Joins first, so rings and dots sit on top of them.
  for (const a of awards) {
    const b = a.solNumber ? bySol.get(a.solNumber) : undefined;
    if (b && a.date >= b.first) {
      parts.push(el('line', { x1: x(b.first), x2: x(a.date), y1: AX, y2: AX, class: 'vs-main', 'stroke-width': 3, 'stroke-opacity': 0.35 }));
    }
  }
  const mark = (attrs: Attrs): string => el('circle', { ...attrs, tabindex: focusable ? 0 : null });
  const rings = buys.map((b) => ({ b, r: eventRadius(b.qty) })).sort((p, q) => q.r - p.r);
  for (const { b, r } of rings) {
    parts.push(
      mark({
        cx: x(b.first),
        cy: AX,
        r,
        class: 'vf-card vs-alt',
        'stroke-width': 2.5,
        'data-tip': tip('Solicitation posted', `${fmtDay(b.first)}${b.qty !== null ? ` · qty ${Math.round(b.qty).toLocaleString('en-US')}` : ''}`, b.solNumbers.length > 1 && `${b.solNumbers.length} solicitations within ${BUY_WINDOW_DAYS} days`),
      })
    );
  }
  const dots = awards.map((a) => ({ a, r: eventRadius(a.quantity) })).sort((p, q) => q.r - p.r);
  for (const { a, r } of dots) {
    parts.push(
      mark({
        cx: x(a.date),
        cy: AX,
        r,
        class: 'vf-main vring',
        'data-tip': tip('Award made', `${fmtDay(a.date)}${a.quantity !== null ? ` · qty ${Math.round(a.quantity).toLocaleString('en-US')}` : ''}${a.supplier ? ` · ${a.supplier}` : ''}`),
      })
    );
  }

  const legend: LegendItem[] = [{ key: 'alt', shape: 'ring', label: 'Solicitation posted' }];
  if (awards.length > 0) legend.push({ key: 'main', label: 'Award made' });
  return {
    svg: svg(W, H, `Timeline of ${buys.length} solicitation rounds and ${awards.length} awards for this item`, parts),
    legend,
    question: 'How often does the government buy this item, and how long since the last time? Every solicitation and award on one line.',
    note: 'Dot size shows quantity. A faint bar joins a solicitation to the award made against it.',
    headline,
    lastLine,
    buys: buys.length,
    awards: awards.length,
  };
}
