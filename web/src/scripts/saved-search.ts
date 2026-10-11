// "Save this search" on /open/ and /open/<fsc>/: reads the filter bar (when the page has one),
// turns it into the normalized search string and follows it. The button reads "Saved" while the
// current filters match a search the visitor already saved. A filter that cannot be saved (see
// lib/saved-search.ts) gets a plain-text reason instead of a half-saved search.

import { ACCOUNTS_ENABLED, type Me } from '../lib/account';
import { filtersFromBar, parseSearchKey, searchKey, searchLabel, type FilterBar } from '../lib/saved-search';
import { followItem, isFollowed, loadMe, toast } from './account';

const btn = document.querySelector<HTMLButtonElement>('[data-save-search]');

function readBar(): FilterBar | null {
  const status = document.getElementById('f-status') as HTMLSelectElement | null;
  if (!status) return null;   // the /open/ hub has no filter bar: it saves "all"
  const val = (id: string): string => (document.getElementById(id) as HTMLSelectElement | null)?.value ?? 'any';
  const comp = document.querySelector<HTMLInputElement>('input[name="f-competition"]:checked')?.value ?? 'all';
  return { status: status.value, closes: val('f-closes'), minqty: val('f-minqty'), competition: comp, hasDrawing: !!(document.getElementById('f-hasdrawing') as HTMLInputElement | null)?.checked };
}

function current(b: HTMLButtonElement): { key: string; label: string } | { reason: string } {
  const fsc = b.dataset.fsc || null;
  const bar = readBar();
  const r = bar ? filtersFromBar(bar, fsc) : { filters: { fsc } };
  if ('reason' in r) return r;
  return { key: searchKey(r.filters), label: searchLabel(r.filters, b.dataset.fscName || null) };
}

function paint(b: HTMLButtonElement, me: Me): void {
  b.hidden = !me.available;
  const c = current(b);
  const on = 'key' in c && me.signedIn && isFollowed(me, 'search', c.key);
  b.setAttribute('aria-pressed', String(on));
  const t = b.querySelector('[data-save-text]');
  if (t) t.textContent = on ? 'Search saved' : 'Save this search';
  b.title = on ? 'Remove this saved search from your watchlist' : 'Get new matching solicitations on your watchlist';
}

/** A link from the watchlist (/open/<fsc>/#search=...) opens the page with that search's filters set. */
function applyHash(): void {
  const m = /^#search=(.+)$/.exec(location.hash);
  const f = m ? parseSearchKey(decodeURIComponent(m[1])) : null;
  const status = document.getElementById('f-status') as HTMLSelectElement | null;
  if (!f || !status) return;
  const set = (id: string, v: string): void => { const el = document.getElementById(id) as HTMLSelectElement | null; if (el && [...el.options].some((o) => o.value === v)) el.value = v; };
  status.value = 'open';
  set('f-closes', f.closes ? String(f.closes) : 'any');
  set('f-minqty', f.minqty ? String(f.minqty) : 'any');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="f-competition"]')) r.checked = r.value === (f.comp ?? 'all');
  status.dispatchEvent(new Event('change'));
}

if (ACCOUNTS_ENABLED && btn) {
  // after the page's own script has attached its filter listeners
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyHash); else applyHash();
  const b = btn;
  const repaint = (): void => { void loadMe().then((me) => paint(b, me)); };
  repaint();
  document.addEventListener('nsn:me', (e) => paint(b, (e as CustomEvent<Me>).detail));
  for (const el of document.querySelectorAll('#f-status, #f-closes, #f-minqty, #f-hasdrawing, input[name="f-competition"]')) el.addEventListener('change', repaint);
  document.getElementById('clear-filters')?.addEventListener('click', () => setTimeout(repaint, 0));
  b.addEventListener('click', async () => {
    const c = current(b);
    if ('reason' in c) { toast(c.reason); return; }
    const on = b.getAttribute('aria-pressed') === 'true';
    b.disabled = true;
    try {
      if (await followItem('search', c.key, c.label, !on)) toast(on ? 'Saved search removed.' : 'Search saved. New solicitations that match will show on your watchlist.');
    } finally { b.disabled = false; }
  });
}
