// viz-nsn-timing.ts — chart 16: days from a solicitation's posting to the
// award made against it, split into "open for quotes" and "closed, awaiting award".
import { MIN_ROWS_BAR, daysBetween, el, hbar, median, monthYear, svg, text, ticks, niceMax, tip } from './viz.ts';
import { fmtDay, plural, tickCount, type SolIn } from './viz-nsn-common.ts';
import type { LegendItem } from './viz-nsn-price.ts';

export interface TimingRow {
  awardedOn: string;
  issuedOn: string;
  open: number;
  closed: number;
  total: number;
  endOpen: string; // the date quotes stopped (return date or award date)
}

/** Awards matched to a solicitation of this item, newest first, at most 8; one row per (solicitation, award date). */
export function timingRows(awards: { awardedOn: string; solNumber: string | null }[], sols: SolIn[]): TimingRow[] {
  const bySol = new Map(sols.map((s) => [s.solNumber, s]));
  const seen = new Set<string>();
  const rows: TimingRow[] = [];
  for (const a of [...awards].sort((p, q) => q.awardedOn.localeCompare(p.awardedOn))) {
    const s = a.solNumber ? bySol.get(a.solNumber) : undefined;
    if (!s || !s.issuedOn || a.awardedOn < s.issuedOn) continue;
    const key = `${s.solNumber}|${a.awardedOn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const endOpen = s.returnBy && s.returnBy < a.awardedOn ? (s.returnBy < s.issuedOn ? s.issuedOn : s.returnBy) : a.awardedOn;
    const open = daysBetween(s.issuedOn, endOpen);
    const closed = daysBetween(endOpen, a.awardedOn);
    rows.push({ awardedOn: a.awardedOn, issuedOn: s.issuedOn, open, closed, total: open + closed, endOpen });
    if (rows.length === 8) break;
  }
  return rows;
}

export interface TimingModel {
  svg: string;
  legend: LegendItem[];
  question: string;
  note: string;
  medianDays: number;
  rows: TimingRow[];
}

const W = 560;
const RH = 26;

export function buildTimeToAward(awards: { awardedOn: string; solNumber: string | null }[], sols: SolIn[]): TimingModel | null {
  const rows = timingRows(awards, sols);
  if (rows.length < MIN_ROWS_BAR) return null;
  const maxDays = Math.max(...rows.map((r) => r.total), 1);
  const top = niceMax(maxDays);
  const gridVals = ticks(maxDays, tickCount(top));
  const left = 70;
  const k = (W - left - 64) / top;
  const H = rows.length * RH + 34;
  const x = (d: number): number => left + d * k;
  const parts: string[] = [];
  parts.push(el('line', { x1: x(0), x2: x(0), y1: 4, y2: rows.length * RH + 4, class: 'vs-axis' }));
  parts.push(text(x(0), rows.length * RH + 20, '0', { 'text-anchor': 'middle' }));
  for (const d of gridVals) {
    parts.push(el('line', { x1: x(d), x2: x(d), y1: 4, y2: rows.length * RH + 4, class: 'vs-grid' }));
    parts.push(text(x(d), rows.length * RH + 20, `${d}d`, { 'text-anchor': 'middle' }));
  }
  const focusable = rows.length * 2 < 40;
  rows.forEach((r, i) => {
    const y = i * RH + 8;
    parts.push(text(0, y + 13, monthYear(r.awardedOn), { class: 'vt-ink' }));
    parts.push(
      hbar(x(0), y, Math.max(0, r.open * k - 1), 16, 'vf-alt', {
        'data-tip': tip('Open for quotes', `${r.open} ${plural(r.open, 'day')} · ${fmtDay(r.issuedOn)} to ${fmtDay(r.endOpen)}`),
        tabindex: focusable ? 0 : null,
      })
    );
    if (r.closed > 0) {
      parts.push(
        hbar(x(r.open) + 1, y, Math.max(0, r.closed * k - 1), 16, 'vf-main', {
          'data-tip': tip('Closed, awaiting award', `${r.closed} ${plural(r.closed, 'day')} · ${fmtDay(r.endOpen)} to ${fmtDay(r.awardedOn)}`),
          tabindex: focusable ? 0 : null,
        })
      );
    }
    parts.push(text(x(r.total) + 6, y + 13, `${r.total} ${plural(r.total, 'day')}`, { class: 'vt-ink' }));
  });
  const med = Math.round(median(rows.map((r) => r.total)));
  const lateMajority = rows.filter((r) => r.closed > r.open).length > rows.length / 2;
  return {
    svg: svg(W, H, `Days from posting to award for the last ${rows.length} buys`, parts),
    legend: [
      { key: 'alt', label: 'Open for quotes' },
      { key: 'main', label: 'Closed, awaiting award' },
    ],
    question: 'How long does a buy take from posting to award? One bar per past award that matches a solicitation.',
    note: `The typical buy took ${med} ${plural(med, 'day')} from posting to award.${lateMajority ? ' Most of that came after quotes closed.' : ''}`,
    medianDays: med,
    rows,
  };
}
