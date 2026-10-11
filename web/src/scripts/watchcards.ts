// Watchlist cards in the browser. One request (/api/account/cards) returns a card for every item
// of a list, read from the public record tables; this file turns each into a small visual plus a
// few lines of facts. The visuals are inline SVG made with the site's chart helpers and colour
// tokens (lib/viz-site.ts sparkPath, viz.css --v-*), so they follow the light / dark switch.
//
// Everything states what the records show: dates, counts, prices, the codes on file. Nothing is
// ranked or recommended. Text comes from lib/watch-text.ts (also used by the CSV).

import { api } from './account';
import { h, link, s, tip } from './dom';
import { itemPath, MAX_CARD_ITEMS, type Item, type Kind } from '../lib/account';
import { sparkPath } from '../lib/viz-site';
import { formatDate, formatUsd, formatUsdPrecise, toDashedNsn, COMPETITION_BADGE, competitionOf } from '../lib/shared';
import {
  countdown, itemHref, itemName, nsnCoding,
  type AgencyCard, type AnyCard, type Cards, type FscCard, type ManufacturerCard, type NsnCard, type SearchCard, type SolicitationCard, type SupplierCard,
} from '../lib/watch-text';
import { parseSearchKey } from '../lib/saved-search';

export type { Cards, AnyCard };

export const cardKey = (i: { kind: string; key: string }): string => `${i.kind}:${i.key}`;
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Cards for these items, in as few requests as the server allows (200 each). Missing items get no card. */
export async function loadCards(items: (Pick<Item, 'kind' | 'key'> & { since?: string | null })[]): Promise<Cards> {
  const seen = new Set<string>();
  const want = items.filter((i) => (seen.has(cardKey(i)) ? false : (seen.add(cardKey(i)), true)))
    .map((i) => ({ kind: i.kind, key: i.key, ...(i.since ? { since: i.since } : {}) }));
  const out: Cards = {};
  for (let n = 0; n < want.length; n += MAX_CARD_ITEMS) {
    try { Object.assign(out, await api<Cards>('cards', { items: want.slice(n, n + MAX_CARD_ITEMS) })); } catch { /* rows still show, without cards */ }
  }
  return out;
}

const n = (x: number): string => x.toLocaleString('en-US');
const date = (d: string | null | undefined): string => (d ? formatDate(d.slice(0, 10)) : '—');
const monthName = (k: string, year = false): string => new Date(`${k}-01T00:00:00Z`).toLocaleDateString('en-US', year ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' });

function stat(label: string, value: Node | string, cls = ''): HTMLElement {
  return h('div', { class: `wl-stat${cls ? ` ${cls}` : ''}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value));
}
const stats = (...cells: HTMLElement[]): HTMLElement => h('div', { class: 'wl-stats' }, ...cells);

/** The last awards' unit prices as a line, oldest to newest. */
function sparkline(prices: [string, number][]): HTMLElement {
  const values = prices.map((p) => Number(p[1]));
  const W = 220, H = 52;
  const path = sparkPath(values, W, H, 6, 8);
  const first = prices[0], last = prices[prices.length - 1];
  const label = `Unit price of the last ${values.length} awards: ${formatUsdPrecise(values[0])} on ${date(first[0])} to ${formatUsdPrecise(values[values.length - 1])} on ${date(last[0])}.`;
  if (!path) return h('div', { class: 'wl-visual-text' }, h('div', { class: 'k' }, 'Only award on record'), h('div', { class: 'v' }, `${formatUsdPrecise(values[0])} each`), h('div', { class: 'k' }, date(first[0])));
  const lo = Math.min(...values), hi = Math.max(...values);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wl-spark', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' },
    s('path', { d: path.area, class: 'vf-main wl-spark-area' }), s('path', { d: path.line, class: 'vs-main wl-spark-line', fill: 'none' }),
    s('circle', { cx: path.last.x, cy: path.last.y, r: 3.5, class: 'vf-main vring' }, tip(`${date(last[0])}: ${formatUsdPrecise(values[values.length - 1])}`)));
  return h('div', { class: 'wl-visual-chart' }, svg as unknown as HTMLElement,
    h('div', { class: 'wl-scale', 'aria-hidden': 'true' }, h('span', {}, date(first[0])), h('span', {}, lo === hi ? formatUsdPrecise(lo) : `${formatUsdPrecise(lo)}–${formatUsdPrecise(hi)}`), h('span', {}, date(last[0]))),
    h('div', { class: 'k' }, `Unit price, last ${values.length} ${values.length === 1 ? 'award' : 'awards'}`));
}

/** Bars of counts per month or week; `fmt` words one bar for its hover text. */
function bars(rows: { label: string; value: number; note: string }[], what: string, first: string, last: string): HTMLElement {
  const W = 240, H = 56, slot = W / rows.length, bw = Math.max(5, slot - 5);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wl-bars', role: 'img', 'aria-label': `${what}: ${n(total)} in total, ${first} to ${last}.`, preserveAspectRatio: 'none' },
    s('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: 'vs-axis', 'stroke-width': 1 }));
  rows.forEach((r, i) => {
    const x = i * slot + (slot - bw) / 2;
    const hh = r.value ? Math.max(2, (r.value / max) * (H - 4)) : 0;
    const rect = s('rect', { x, y: H - hh - 1, width: bw, height: hh, rx: 1.5, class: 'vf-main' }, tip(`${r.label}: ${r.note}`));
    svg.append(rect);
    if (!r.value) svg.append(s('rect', { x, y: H - 3, width: bw, height: 2, rx: 1, class: 'vf-neutral' }, tip(`${r.label}: ${r.note}`)));
  });
  return h('div', { class: 'wl-visual-chart' }, svg as unknown as HTMLElement,
    h('div', { class: 'wl-scale', 'aria-hidden': 'true' }, h('span', {}, first), h('span', {}, ''), h('span', {}, last)),
    h('div', { class: 'k' }, what));
}

const tile = (label: string, value: string, sub?: string): HTMLElement =>
  h('div', { class: 'wl-tile' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 'k' }, sub) : null);

function recordRows(rows: { date: string | null; main: Node | string; right: string; url: string | null }[]): HTMLElement {
  return h('ul', { class: 'wl-recs' }, ...rows.map((r) => h('li', {},
    h('span', { class: 'when' }, date(r.date)), h('span', { class: 'what' }, r.main), h('span', { class: 'amt' }, r.right),
    r.url ? h('a', { href: r.url, rel: 'noopener nofollow', target: '_blank', 'aria-label': 'Source record' }, 'Source') : h('span', {}, ''))));
}

export interface CardView { visual: HTMLElement | null; details: HTMLElement; sub: string | null; link: string }

/** The row's card: a visual, the facts beside it, a short line under the name, and the page it links to. */
export function renderCard(item: Pick<Item, 'kind' | 'key' | 'label'>, raw: AnyCard | undefined, today = todayIso()): CardView {
  const path = itemHref(item, raw);
  if (!raw) return { visual: null, details: h('p', { class: 'wl-none' }, 'No record found for this page. It may have been removed or renamed.'), sub: null, link: path };
  switch (item.kind) {
    case 'nsn': {
      const c = raw as NsnCard;
      const code = competitionOf(c.amc, c.amsc);
      const latest = c.latest;
      return {
        sub: [c.fsc ? `FSC ${c.fsc}` : '', toDashedNsn(item.key)].filter(Boolean).join(' · '), link: path,
        visual: c.prices.length ? sparkline(c.prices) : h('div', { class: 'wl-visual-text' }, h('div', { class: 'k' }, 'Awards on record'), h('div', { class: 'v' }, '0')),
        details: stats(
          stat('Latest award', latest ? `${formatUsdPrecise(latest.unit_price)} each · ${date(latest.date)}` : 'None on record'),
          stat('Supplier', latest ? (latest.supplier ?? (latest.cage ? `CAGE ${latest.cage}` : 'Not named')) : '—'),
          stat('Open RFQs', c.open_rfqs ? `${n(c.open_rfqs)} · soonest return-by ${date(c.next_return_by)}` : 'None open'),
          stat('Competition coding', h('span', { class: `badge ${code === 'open' ? 'green' : code === 'restricted' ? 'amber' : ''}`, title: `AMC ${c.amc ?? '—'}, AMSC ${c.amsc ?? '—'}` }, nsnCoding(c)))),
      };
    }
    case 'supplier': {
      const c = raw as SupplierCard;
      const rows = c.months.map((m) => ({ label: monthName(m[0], true), value: m[1], note: `${m[1]} ${m[1] === 1 ? 'award' : 'awards'}${m[2] ? `, ${formatUsd(Number(m[2]))}` : ''}` }));
      const n12 = c.months.reduce((a, m) => a + m[1], 0), v12 = c.months.reduce((a, m) => a + Number(m[2]), 0);
      return {
        sub: [c.city, c.state].filter(Boolean).join(', ') || null, link: path,
        visual: bars(rows, 'Awards won per month, last 12 months', monthName(c.months[0][0]), monthName(c.months[c.months.length - 1][0])),
        details: h('div', {}, stats(stat('Last 12 months', `${n(n12)} ${n12 === 1 ? 'award' : 'awards'}${v12 ? ` · ${formatUsd(v12)}` : ''}`), stat('On record', `${n(c.award_count)} awards`)),
          c.wins.length ? recordRows(c.wins.map((w) => ({ date: w.date, main: h('span', {}, h('a', { href: itemPath('nsn', w.nsn) }, toDashedNsn(w.nsn)), w.item ? ` ${w.item}` : ''), right: `${formatUsdPrecise(w.unit_price)}${w.quantity != null ? ` × ${n(w.quantity)}` : ''}`, url: w.url }))) : null),
      };
    }
    case 'manufacturer': {
      const c = raw as ManufacturerCard;
      return {
        sub: c.name, link: path,
        visual: h('div', { class: 'wl-tiles' }, tile('Part numbers', n(c.part_count), `on ${n(c.nsn_count)} ${c.nsn_count === 1 ? 'NSN' : 'NSNs'}`), tile('Open RFQs on its parts', n(c.open_rfqs))),
        details: c.rfqs.length
          ? h('div', {}, h('p', { class: 'k' }, 'Latest open RFQs for its parts'), recordRows(c.rfqs.map((r) => ({ date: r.return_by, main: h('span', {}, h('a', { href: `/solicitation/${encodeURIComponent(r.sol)}/` }, r.sol), r.item ? ` ${r.item}` : ''), right: r.quantity != null ? `qty ${n(r.quantity)}` : '', url: r.url }))))
          : h('p', { class: 'wl-none' }, 'No open RFQs for the parts this CAGE is listed as making.'),
      };
    }
    case 'fsc': {
      const c = raw as FscCard;
      const rows = c.weeks.map((w) => ({ label: `Week of ${date(w[0])}`, value: w[1], note: `${w[1]} posted` }));
      return {
        sub: c.name, link: path,
        visual: bars(rows, 'Solicitations posted per week, last 12 weeks', date(c.weeks[0][0]), date(c.weeks[c.weeks.length - 1][0])),
        details: h('div', {}, stats(stat('Open now', n(c.open_now)), stat('Posted, last 7 days', n(c.posted_7d)), stat('Posted, 12 weeks', n(c.weeks.reduce((a, w) => a + w[1], 0)))),
          c.has_open === false ? null : h('p', { class: 'k' }, h('a', { href: `/open/${item.key}/` }, 'Open demand in this class'))),
      };
    }
    case 'solicitation': {
      const c = raw as SolicitationCard;
      const open = c.status === 'open';
      return {
        sub: c.item, link: path,
        visual: h('div', { class: 'wl-tiles' }, tile('Status', c.status, open ? countdown(c.return_by, today) : `return-by ${date(c.return_by)}`)),
        details: stats(
          stat('NSN', c.nsn ? h('a', { href: itemPath('nsn', c.nsn) }, toDashedNsn(c.nsn)) : '—'),
          stat('Quantity', c.quantity != null ? `${n(c.quantity)}${c.unit ? ` ${c.unit}` : ''}` : '—'),
          stat('Issued', date(c.issued_on)), stat('Return by', date(c.return_by)),
          stat('Award', c.award ? `${formatUsdPrecise(c.award.unit_price)} each · ${c.award.supplier ?? (c.award.cage ? `CAGE ${c.award.cage}` : 'supplier not named')} · ${date(c.award.date)}` : 'None posted'),
          stat('Record', link(c.url, c.source === 'sam_gov' ? 'SAM.gov' : 'DIBBS', undefined, true))),
      };
    }
    case 'agency': {
      const c = raw as AgencyCard;
      return {
        sub: c.abbreviation ?? null, link: path,
        visual: h('div', { class: 'wl-tiles' }, tile('Contract actions, 90 days', n(c.actions_90d.count), c.actions_90d.value ? formatUsd(c.actions_90d.value) : undefined), tile('Part awards, 90 days', n(c.awards_90d.count), c.awards_90d.value ? formatUsd(c.awards_90d.value) : undefined)),
        details: c.latest.length
          ? h('div', {}, h('p', { class: 'k' }, 'Latest contract actions'), recordRows(c.latest.map((a) => ({ date: a.date, main: a.recipient ?? a.description ?? 'Recipient not named', right: a.obligation != null ? formatUsd(a.obligation) : '', url: a.url }))))
          : h('p', { class: 'wl-none' }, 'No contract actions on record for this agency.'),
      };
    }
    case 'search': {
      const c = raw as SearchCard;
      const f = parseSearchKey(item.key) ?? {};
      const words = [f.fsc ? `class ${f.fsc}` : 'all classes', f.closes ? `return-by within ${f.closes} days` : '', f.minqty ? `open quantity ${n(f.minqty)} or more` : '', f.comp ? (f.comp === 'open' ? COMPETITION_BADGE.open.toLowerCase() : COMPETITION_BADGE.restricted.toLowerCase()) : ''].filter(Boolean);
      return {
        sub: null, link: path,
        visual: h('div', { class: 'wl-tiles' }, tile('Parts open now', n(c.open_now), `${n(c.solicitations)} ${c.solicitations === 1 ? 'solicitation' : 'solicitations'}`), tile('New since review', n(c.new_since))),
        details: h('div', {}, h('p', { class: 'k' }, 'Filters'), h('p', {}, words.join(', ')), h('p', { class: 'k' }, h('a', { href: path }, 'Open this search'))),
      };
    }
  }
}

export { itemName };
export type { Kind };
