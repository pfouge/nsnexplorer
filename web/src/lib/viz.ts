// lib/viz.ts — shared, dependency-free helpers for the site's server-rendered
// SVG charts. Pure (no pg, no DOM): safe in prerendered pages AND in the
// on-demand NSN route. Charts are emitted as SVG strings at render time and
// styled only through the classes in styles/viz.css, so they follow the
// light/dark theme with no client chart library.
//
// Conventions every chart follows:
//  - Color is a class, never a literal: vf-* fills, vs-* strokes (viz.css).
//    main = single series / magnitude, alt = second series, warn = closing
//    soon, flag = out-of-range, neutral = "other"/not coded.
//  - Hover text goes in data-tip (plain text; first line is shown bold, "\n"
//    separates lines). scripts/viz.ts turns it into the tooltip with
//    textContent, so untrusted strings (SAM titles, supplier names) are safe.
//  - One y-axis per chart. Bars are anchored to the baseline with a rounded
//    data end; adjacent fills keep a 2px gap; overlapping marks get a
//    card-colored 2px ring (class vring).
//  - A chart with too little data is not rendered at all (see MIN_* below).

export const MIN_POINTS_PRICE = 3; // awards with a unit price
export const MIN_POINTS_QTY_CURVE = 5; // and at least 3 distinct quantities
export const MIN_BUYS_RHYTHM = 2;
export const MIN_ROWS_BAR = 2;

export type Attrs = Record<string, string | number | null | undefined | false>;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Builds one SVG/HTML element as a string; attribute values are escaped. */
export function el(tag: string, attrs: Attrs = {}, children: string | string[] = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? round(v, 2) : v)}"`)
    .join('');
  const body = Array.isArray(children) ? children.join('') : children;
  return `<${tag}${a}>${body}</${tag}>`;
}

/** SVG <text>; `str` is escaped. */
export function text(x: number, y: number, str: unknown, attrs: Attrs = {}): string {
  return el('text', { x, y, ...attrs }, esc(str));
}

/** Root <svg>; width is 100% of its container, height follows the viewBox. */
export function svg(w: number, h: number, label: string, children: string | string[]): string {
  // viz-wide charts keep a readable minimum width on phones and scroll
  // sideways inside their frame (see .viz-body in viz.css).
  return el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', role: 'img', 'aria-label': label, class: w > 700 ? 'viz-svg viz-wide' : 'viz-svg' }, children);
}

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}K`;
  return `${s}$${fmtInt(a)}`;
}

/** Unit prices keep cents below $100 and drop them above. */
export function fmtPrice(v: number): string {
  return v >= 100
    ? `$${fmtInt(v)}`
    : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' -> 'Oct 2026'. */
export function monthYear(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
/** 'YYYY-MM-DD' -> 'Oct 5'. */
export function monthDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}
/** Whole days from `a` to `b` (ISO dates), b - a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
}

export type Scale = (v: number) => number;
export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}
/** Log10 scale; values below 1 are clamped to 1. */
export function log10(d0: number, d1: number, r0: number, r1: number): Scale {
  const l0 = Math.log10(Math.max(1, d0));
  const l1 = Math.log10(Math.max(1, d1));
  const span = l1 - l0 || 1;
  return (v) => r0 + ((Math.log10(Math.max(1, v)) - l0) / span) * (r1 - r0);
}

/** A "nice" axis maximum (1, 2, 2.5, 5 × 10^n) at or above `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
/** Evenly spaced ticks from 0 to niceMax(max), excluding 0. */
export function ticks(max: number, count = 3): number[] {
  const top = niceMax(max);
  return Array.from({ length: count }, (_, i) => (top / count) * (i + 1));
}

export function quantile(sorted: number[], f: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * f;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/** Vertical bar from the baseline up, rounded at the data end only. */
export function vbar(x: number, baseY: number, w: number, h: number, cls: string, attrs: Attrs = {}): string {
  if (!(h > 0) || !(w > 0)) return '';
  const r = Math.min(3, h, w / 2);
  const d = `M${round(x)},${round(baseY)}v${-round(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${round(w - 2 * r)}a${r},${r} 0 0 1 ${r},${r}v${round(h - r)}z`;
  return el('path', { d, class: cls, ...attrs });
}
/** Horizontal bar from x rightwards, rounded at the data end only. */
export function hbar(x: number, y: number, w: number, h: number, cls: string, attrs: Attrs = {}): string {
  if (!(w > 0) || !(h > 0)) return '';
  const r = Math.min(3, w, h / 2);
  const d = `M${round(x)},${round(y)}h${round(w - r)}a${r},${r} 0 0 1 ${r},${r}v${round(h - 2 * r)}a${r},${r} 0 0 1 ${-r},${r}h${-round(w - r)}z`;
  return el('path', { d, class: cls, ...attrs });
}

export interface TreeItem {
  name: string;
  value: number;
}
export interface TreeRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Binary-split treemap. `items` must be sorted by value, largest first. */
export function treemap<T extends TreeItem>(items: T[], x: number, y: number, w: number, h: number): TreeRect<T>[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ item: items[0], x, y, w, h }];
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  let acc = 0;
  let k = 0;
  while (k < items.length - 1 && acc + items[k].value <= total / 2) {
    acc += items[k].value;
    k += 1;
  }
  if (k === 0) {
    acc = items[0].value;
    k = 1;
  }
  const f = acc / total;
  return w >= h
    ? [...treemap(items.slice(0, k), x, y, w * f, h), ...treemap(items.slice(k), x + w * f, y, w * (1 - f), h)]
    : [...treemap(items.slice(0, k), x, y, w, h * f), ...treemap(items.slice(k), x, y + h * f, w, h * (1 - f))];
}

/** State tile grid: [postal code, row, column]. 50 states + DC. */
export const STATE_TILES: [string, number, number][] = [
  ['AK', 0, 0], ['ME', 0, 10], ['VT', 1, 9], ['NH', 1, 10],
  ['WA', 2, 0], ['ID', 2, 1], ['MT', 2, 2], ['ND', 2, 3], ['MN', 2, 4], ['IL', 2, 5], ['WI', 2, 6], ['MI', 2, 7], ['NY', 2, 8], ['RI', 2, 9], ['MA', 2, 10],
  ['OR', 3, 0], ['NV', 3, 1], ['WY', 3, 2], ['SD', 3, 3], ['IA', 3, 4], ['IN', 3, 5], ['OH', 3, 6], ['PA', 3, 7], ['NJ', 3, 8], ['CT', 3, 9],
  ['CA', 4, 0], ['UT', 4, 1], ['CO', 4, 2], ['NE', 4, 3], ['MO', 4, 4], ['KY', 4, 5], ['WV', 4, 6], ['VA', 4, 7], ['MD', 4, 8], ['DE', 4, 9],
  ['AZ', 5, 1], ['NM', 5, 2], ['KS', 5, 3], ['AR', 5, 4], ['TN', 5, 5], ['NC', 5, 6], ['SC', 5, 7], ['DC', 5, 8],
  ['OK', 6, 3], ['LA', 6, 4], ['MS', 6, 5], ['AL', 6, 6], ['GA', 6, 7],
  ['HI', 7, 0], ['TX', 7, 3], ['FL', 7, 8],
];

/** Five-step sequential opacity for one hue (cells, tiles). */
export const SEQ_OPACITY = [0.12, 0.3, 0.5, 0.72, 0.95];
/** Bin 0..4 for `v` against `max` (0 values get bin 0). */
export function seqBin(v: number, max: number): number {
  if (!(v > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.floor((v / max) * 5));
}
/** Text on a sequential cell flips to the on-color class at the dark end. */
export const seqTextClass = (bin: number): string => (bin >= 3 ? 'vt-on' : 'vt-ink');

/** Joins tooltip lines for a data-tip attribute (first line renders bold). */
export function tip(...lines: (string | null | undefined | false)[]): string {
  return lines.filter(Boolean).join('\n');
}
