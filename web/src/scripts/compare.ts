// scripts/compare.ts — the compare tool. State lives in location.hash as NSNs
// (dashed) joined by commas. For each entry it fetches /api/nsn/<dashed>.json
// and draws up to three panels in ONE svg, built with DOM methods only
// (createElementNS + textContent), so item names and supplier text from
// government data can never become markup. Colors come from viz.css classes.
import { monthYear } from '../lib/viz';
import { axisFor, fmtAxisPrice, fmtDay, money, plural } from '../lib/viz-nsn-common';

const NS = 'http://www.w3.org/2000/svg';
const MAX_PANELS = 3;

interface ApiItem {
  nsn: { itemName: string | null; amsc: string | null; amc: string | null };
  pricePoints: { awardedOn: string; unitPrice: number }[];
  contractActions: unknown[];
  solicitations: { status: string }[];
}
type Panel =
  | { kind: 'item'; dashed: string; name: string; open: number; awards: number; competition: string; series: { t: number; iso: string; p: number }[] }
  | { kind: 'missing'; input: string }
  | { kind: 'error'; input: string; dashed: string };

/** '5331011234567', '5331-01-123-4567' -> dashed form; anything else -> null. */
export function toDashed(input: string): string | null {
  if (!/^[\d\s-]+$/.test(input)) return null;
  const d = input.replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 9)}-${d.slice(9)}` : null;
}

function readHash(): string[] {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    let v = part;
    try {
      v = decodeURIComponent(part);
    } catch {
      /* keep the raw text */
    }
    v = v.trim();
    if (v && !out.includes(toDashed(v) ?? v)) out.push(toDashed(v) ?? v);
    if (out.length === MAX_PANELS) break;
  }
  return out;
}
const hashFor = (entries: string[]): string => entries.map((e) => (toDashed(e) ? e : encodeURIComponent(e))).join(',');

function S(tag: string, attrs: Record<string, string | number>, parent?: Element, str?: string): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(typeof v === 'number' ? Math.round(v * 10) / 10 : v));
  if (str !== undefined) e.textContent = str;
  parent?.appendChild(e);
  return e as SVGElement;
}
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

async function load(entry: string): Promise<Panel> {
  const dashed = toDashed(entry);
  if (!dashed) return { kind: 'missing', input: entry };
  try {
    const res = await fetch(`/api/nsn/${dashed}.json`);
    if (res.status === 404 || res.status === 400) return { kind: 'missing', input: entry };
    if (!res.ok) return { kind: 'error', input: entry, dashed };
    const j = (await res.json()) as ApiItem;
    const series = (j.pricePoints ?? [])
      .map((p) => ({ iso: String(p.awardedOn).slice(0, 10), p: Number(p.unitPrice) }))
      .filter((p) => Number.isFinite(p.p))
      .sort((a, b) => a.iso.localeCompare(b.iso))
      .map((p) => ({ ...p, t: Date.parse(`${p.iso}T00:00:00Z`) }));
    const n = j.nsn;
    const competition = n.amsc === 'G' || n.amsc === 'Z' || n.amc === '1' || n.amc === '2' ? 'open competition' : n.amsc || n.amc ? 'restricted' : 'competition not recorded';
    return {
      kind: 'item',
      dashed,
      name: n.itemName?.trim() || `NSN ${dashed}`,
      open: (j.solicitations ?? []).filter((s) => s.status === 'open').length,
      awards: series.length + (j.contractActions ?? []).length,
      competition,
      series,
    };
  } catch {
    return { kind: 'error', input: entry, dashed };
  }
}

/** Draws every panel into one svg. Wide: side by side; narrow: stacked, so text stays legible. */
export function draw(panels: Panel[], narrow: boolean): SVGSVGElement {
  const n = panels.length;
  const charted = panels.filter((p): p is Extract<Panel, { kind: 'item' }> => p.kind === 'item' && p.series.length >= 2);
  const all = charted.flatMap((p) => p.series);
  const yMax = all.length ? Math.max(...all.map((d) => d.p)) : 1;
  const axis = axisFor(yMax || 1);
  let t0 = all.length ? Math.min(...all.map((d) => d.t)) : 0;
  let t1 = all.length ? Math.max(...all.map((d) => d.t)) : 1;
  if (t1 - t0 < 30 * 86400000) {
    t0 -= 15 * 86400000;
    t1 += 15 * 86400000;
  }
  const W = narrow ? 360 : 1160;
  const gap = narrow ? 24 : 36;
  const left = narrow ? 58 : 48;
  const pw = narrow ? W - left - 14 : (W - left - 20 - gap * (n - 1)) / n;
  const PH = 262;
  const H = narrow ? n * PH : PH;
  const svg = S('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Unit price over time for ${n} ${plural(n, 'item')} on a shared scale`, class: 'viz-svg' });
  const marks = all.length;
  const focusable = marks < 40;

  panels.forEach((panel, k) => {
    const x0 = narrow ? left : left + k * (pw + gap);
    const oy = narrow ? k * PH : 0;
    const top = oy + 48;
    const base = oy + 186;
    const maxChars = Math.floor(pw / 7.4);
    if (panel.kind !== 'item') {
      const label = clip(panel.input, 36);
      S('text', { x: x0, y: oy + 14, class: 'vt-ink vt-b vt-lg' }, svg, label);
      S('text', { x: x0, y: oy + 52, class: 'vt-ink' }, svg, panel.kind === 'missing' ? `No item found for ${label}.` : `Could not load ${panel.dashed} right now. Try again.`);
      return;
    }
    const title = S('text', { x: x0, y: oy + 14, class: 'vt-ink vt-b vt-lg' }, svg, clip(panel.name, maxChars));
    S('title', {}, title, panel.name);
    S('text', { x: x0, y: oy + 30, class: 'vt-mono' }, svg, panel.dashed);
    const y = (v: number): number => base - (v / axis.top) * (base - top);
    const x = (t: number): number => x0 + ((t - t0) / (t1 - t0)) * pw;
    if (charted.length) {
      for (const v of axis.values) {
        S('line', { x1: x0, x2: x0 + pw, y1: y(v), y2: y(v), class: 'vs-grid' }, svg);
        if (k === 0 || narrow) S('text', { x: x0 - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg, fmtAxisPrice(v, axis.step));
      }
      if (k === 0 || narrow) S('text', { x: x0 - 6, y: base + 4, 'text-anchor': 'end' }, svg, '$0');
      S('line', { x1: x0, x2: x0 + pw, y1: base, y2: base, class: 'vs-axis' }, svg);
    }
    if (panel.series.length >= 2) {
      S('path', { d: panel.series.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.p).toFixed(1)}`).join(''), class: 'vf-none vs-main', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
      S('text', { x: x0, y: base + 16 }, svg, monthYear(new Date(t0).toISOString().slice(0, 10)));
      S('text', { x: x0 + pw, y: base + 16, 'text-anchor': 'end' }, svg, monthYear(new Date(t1).toISOString().slice(0, 10)));
      for (const d of panel.series) {
        S('circle', { cx: x(d.t), cy: y(d.p), r: 7, class: 'vf-clear', 'data-tip': `${money(d.p)} each\n${fmtDay(d.iso)} · ${panel.name}`, ...(focusable ? { tabindex: 0 } : {}) }, svg);
      }
      const last = panel.series[panel.series.length - 1];
      S('circle', { cx: x(last.t), cy: y(last.p), r: 4, class: 'vf-main vring' }, svg);
      const ly = y(last.p) - 10 < top - 6 ? y(last.p) + 18 : y(last.p) - 10;
      S('text', { x: x(last.t) - 6, y: ly, 'text-anchor': 'end', class: 'vt-ink vt-b vt-halo' }, svg, money(last.p));
    } else {
      S('text', { x: x0, y: top + 24, class: 'vt-ink' }, svg, 'No price history on record.');
    }
    S('text', { x: x0, y: oy + 222, class: 'vt-ink' }, svg, `${panel.open.toLocaleString('en-US')} open · ${panel.awards.toLocaleString('en-US')} ${plural(panel.awards, 'award')} · ${panel.competition}`);
    const a = S('a', { href: `/nsn/${panel.dashed}/` }, svg);
    S('text', { x: x0, y: oy + 242, class: 'vt-link' }, a, 'View this item →');
  });
  return svg as SVGSVGElement;
}

const form = document.getElementById('compare-form') as HTMLFormElement | null;
const out = document.getElementById('compare-out');
const status = document.getElementById('compare-status');
const inputs = form ? Array.from(form.querySelectorAll<HTMLInputElement>('input[type="text"]')) : [];
const narrowQuery = window.matchMedia('(max-width: 700px)');
let token = 0;
let current: Panel[] = [];

function mount(): void {
  if (!out) return;
  out.textContent = '';
  if (current.length === 0) return;
  const fig = document.createElement('figure');
  fig.className = 'viz viz-panel full';
  const cap = document.createElement('figcaption');
  const head = document.createElement('div');
  head.className = 'viz-head';
  const h = document.createElement('h2');
  h.className = 'viz-title';
  h.textContent = 'Unit price by award date';
  head.appendChild(h);
  cap.appendChild(head);
  fig.appendChild(cap);
  fig.appendChild(draw(current, narrowQuery.matches));
  if (current.length > 1) {
    const note = document.createElement('p');
    note.className = 'viz-note';
    note.textContent = `All ${current.length} panels share one price scale and one time axis, so heights compare directly.`;
    fig.appendChild(note);
  }
  out.appendChild(fig);
}

async function render(): Promise<void> {
  const entries = readHash();
  inputs.forEach((inp, i) => (inp.value = entries[i] ?? ''));
  const mine = ++token;
  if (entries.length === 0) {
    current = [];
    if (status) status.textContent = '';
    mount();
    return;
  }
  if (status) status.textContent = 'Loading…';
  const panels = await Promise.all(entries.map(load));
  if (mine !== token) return;
  current = panels;
  if (status) status.textContent = '';
  mount();
}

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const entries: string[] = [];
  for (const inp of inputs) {
    const v = inp.value.trim();
    const norm = v ? toDashed(v) ?? v : '';
    if (norm && !entries.includes(norm)) entries.push(norm);
  }
  const next = hashFor(entries);
  if (next === location.hash.replace(/^#/, '')) void render();
  else location.hash = next;
});
window.addEventListener('hashchange', () => void render());
narrowQuery.addEventListener('change', mount);
void render();
