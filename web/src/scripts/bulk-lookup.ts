// scripts/bulk-lookup.ts — client for /lookup/. Parses the pasted list with
// parseBulkInput, fetches /api/bulk.json in sequential chunks of 50, and draws
// the table with DOM methods only (textContent), so item names from government
// data can never become markup. Nothing is stored; the text never leaves the
// textarea except as NSN/NIIN query parameters.
import { BULK_CHUNK_SIZE, chunk, parseBulkInput, toCsv } from '../lib/bulk-lookup';
import { formatDate, formatUsdPrecise } from '../lib/shared';
import { h } from './dom';

interface Item {
  nsn: string;
  niin: string;
  fsc: string;
  className: string | null;
  itemName: string | null;
  amc: string | null;
  amsc: string | null;
  competition: 'open' | 'restricted' | 'unknown';
  competitionLabel: string;
  pricePoints: number;
  lastPrice: { unitPrice: number; awardedOn: string; sourceUrl: string } | null;
  recentLow: number | null;
  recentHigh: number | null;
  openSolicitations: number;
  earliestReturnBy: string | null;
  openQuantity: number | null;
  url: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('bulk-form');
const input = $<HTMLTextAreaElement>('bulk-input');
const runBtn = $<HTMLButtonElement>('bulk-run');
const csvBtn = $<HTMLButtonElement>('bulk-csv');
const countEl = $('bulk-count');
const statusEl = $('bulk-status');
const out = $('bulk-out');

const n = (v: number) => v.toLocaleString('en-US');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const usd = (v: number) => formatUsdPrecise(v);

let results: Item[] = [];
let notFound: string[] = [];
let rejected: string[] = [];

function updateCount() {
  const p = parseBulkInput(input.value);
  const ids = p.nsns.length + p.niins.length;
  const parts = [p.niins.length ? `${plural(p.nsns.length, 'NSN')} · ${plural(p.niins.length, 'NIIN')}` : plural(p.nsns.length, 'NSN')];
  if (p.rejected.length) parts.push(`${p.rejected.length} not recognised`);
  if (p.truncated) parts.push(`only the first ${n(ids)} will be looked up`);
  countEl.textContent = parts.join(' · ');
}

const badge = (it: Item) =>
  h('span', { class: `badge ${it.competition === 'open' ? 'green' : it.competition === 'restricted' ? 'amber' : ''}`, title: `AMC ${it.amc ?? '—'}, AMSC ${it.amsc ?? '—'}` }, it.competitionLabel);

function row(it: Item): HTMLElement {
  const lp = it.lastPrice;
  const range =
    it.recentLow === null || it.recentHigh === null ? '—' : it.recentLow === it.recentHigh ? usd(it.recentLow) : `${usd(it.recentLow)} – ${usd(it.recentHigh)}`;
  const bids = it.openSolicitations
    ? `${n(it.openSolicitations)} open${it.earliestReturnBy ? ` · closes ${formatDate(it.earliestReturnBy)}` : ''}${it.openQuantity !== null ? ` · qty ${n(it.openQuantity)}` : ''}`
    : '—';
  return h(
    'tr',
    {},
    h('td', {}, h('a', { href: it.url, class: 'code' }, it.nsn)),
    h('td', { class: 'wrap' }, it.itemName ?? '—'),
    h('td', { class: 'wrap' }, h('a', { href: `/fsc/${it.fsc}/` }, `${it.fsc}${it.className ? ` ${it.className}` : ''}`)),
    h('td', {}, badge(it)),
    h(
      'td',
      { class: 'num' },
      lp ? h('a', { href: lp.sourceUrl, target: '_blank', rel: 'nofollow noopener' }, usd(lp.unitPrice)) : '—',
      lp ? h('div', { class: 'gloss' }, formatDate(lp.awardedOn)) : null
    ),
    h('td', { class: 'num' }, range),
    h('td', { class: 'num' }, n(it.pricePoints)),
    h('td', {}, bids)
  );
}

function listBlock(title: string, items: string[], note: string): HTMLElement {
  return h('section', {}, h('h2', { class: 'section-title' }, `${title} (${items.length})`), h('p', { class: 'gloss' }, note), h('p', { class: 'mono' }, items.join(', ')));
}

function render() {
  const kids: Node[] = [];
  if (results.length) {
    const head = ['NSN', 'Item', 'Class', 'Competition', 'Last price', 'Last-5 range', 'Prices on record', 'Open bids'];
    kids.push(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('caption', {}, `${plural(results.length, 'NSN')} found`),
          h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { class: i >= 4 && i <= 6 ? 'num' : '' }, t)))),
          h('tbody', {}, ...results.map(row))
        )
      )
    );
  }
  if (notFound.length) kids.push(listBlock('Not in our catalog', notFound, 'These are valid numbers that are not in our catalog yet.'));
  if (rejected.length) kids.push(listBlock('Not recognised', rejected, 'These are not 13-digit NSNs or 9-digit NIINs.'));
  out.replaceChildren(...kids);
  csvBtn.hidden = results.length === 0;
}

function csv(): string {
  const headers = ['NSN', 'NIIN', 'FSC', 'Class', 'Item', 'AMC', 'AMSC', 'Competition', 'Last price', 'Last price date', 'Last price source', 'Last-5 low', 'Last-5 high', 'Prices on record', 'Open bids', 'Earliest closing date', 'Open quantity', 'URL'];
  return toCsv(
    results.map((it) => [
      it.nsn, it.niin, it.fsc, it.className, it.itemName, it.amc, it.amsc, it.competitionLabel,
      it.lastPrice?.unitPrice, it.lastPrice?.awardedOn, it.lastPrice?.sourceUrl, it.recentLow, it.recentHigh,
      it.pricePoints, it.openSolicitations, it.earliestReturnBy, it.openQuantity, `${location.origin}${it.url}`,
    ]),
    headers
  );
}

async function run() {
  const p = parseBulkInput(input.value);
  const ids = [...p.nsns, ...p.niins];
  results = [];
  notFound = [];
  rejected = p.rejected;
  render();
  if (!ids.length) {
    statusEl.textContent = 'Paste at least one 13-digit NSN or 9-digit NIIN.';
    return;
  }
  runBtn.disabled = true;
  const failed: string[] = [];
  let done = 0;
  for (const part of chunk(ids, BULK_CHUNK_SIZE)) {
    statusEl.textContent = `Looked up ${n(done)} of ${n(ids.length)}…`;
    try {
      const res = await fetch(`/api/bulk.json?ids=${part.join(',')}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !Array.isArray(body.results)) throw new Error(body?.error ?? `HTTP ${res.status}`);
      results.push(...(body.results as Item[]));
      notFound.push(...(body.notFound as string[]));
    } catch (e) {
      failed.push(`Items ${n(done + 1)}–${n(done + part.length)} could not be looked up (${e instanceof Error ? e.message : 'network error'}).`);
    }
    done += part.length;
    render();
  }
  const rank = (it: Item) => {
    const i = ids.indexOf(it.nsn.replace(/-/g, ''));
    return i >= 0 ? i : ids.indexOf(it.niin) >= 0 ? ids.indexOf(it.niin) : ids.length;
  };
  results.sort((a, b) => rank(a) - rank(b) || a.nsn.localeCompare(b.nsn));
  render();
  runBtn.disabled = false;
  statusEl.textContent = [`Looked up ${n(ids.length)} of ${n(ids.length)}.`, p.truncated ? 'The list was cut to the first 500.' : '', ...failed, failed.length ? 'Results above are partial; press Look up to retry.' : ''].filter(Boolean).join(' ');
}

input.addEventListener('input', updateCount);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  void run();
});
csvBtn.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([csv()], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `nsn-lookup-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
updateCount();
