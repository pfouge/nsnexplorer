// /watchlist/ and /watchlist/shared/#<slug>. Both pages are static shells; this script fills them
// from the account API. Everything is built with DOM methods and textContent, never innerHTML,
// because names and labels come from public records and from visitors.
//
// Own page, top to bottom: what changed since each item was last reviewed; the lists (tabs), each
// row being name | card | details (stacked under 900px); the account (sign out, delete).

import { api, loadMe, setMe, signInUrl, toast } from './account';
import { h } from './dom';
import { cardKey, loadCards, renderCard, todayIso, type Cards } from './watchcards';
import { KIND_LABEL, type Item, type ListState, type Me } from '../lib/account';
import { CSV_BOM } from '../lib/csv';
import { EVENT_LABEL, changeCount, eventText, itemHref, itemName, watchCsv, type Feed, type FeedItem } from '../lib/watch-text';
import { formatDate } from '../lib/shared';

const when = (iso: string | null | undefined): string => (iso ? formatDate(iso.slice(0, 10)) : '—');
const LIST_KEY = 'nsn_wl_list';
const getStored = (k: string): string | null => { try { return sessionStorage.getItem(k); } catch { return null; } };
const setStored = (k: string, v: string): void => { try { sessionStorage.setItem(k, v); } catch { /* optional */ } };

const since = (i: Item): string => i.reviewed_at ?? i.added_at ?? '';
const feedKey = (list: string, i: { kind: string; key: string }): string => `${list}:${i.kind}:${i.key}`;

function csvDownload(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slugName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list';

function itemRow(l: { id: string; name: string }, i: Item, cards: Cards, fi: FeedItem | undefined, actions: HTMLElement | null, details: HTMLElement[] = []): HTMLElement {
  void l;
  const v = renderCard(i, cards[cardKey(i)]);
  const name = i.label || itemName(i, cards[cardKey(i)]);
  return h('li', { class: `wl-row wl-row-${i.kind}${fi ? ' has-changes' : ''}`, 'data-kind': i.kind, 'data-key': i.key },
    h('div', { class: 'wl-main' },
      h('span', { class: 'wl-kind' }, KIND_LABEL[i.kind]),
      h('a', { class: 'wl-name', href: v.link }, name),
      v.sub ? h('span', { class: 'wl-sub' }, v.sub) : null,
      fi ? h('span', { class: 'badge amber wl-changed' }, changeCount(fi.count)) : null,
      actions),
    h('div', { class: 'wl-visual' }, v.visual),
    h('div', { class: 'wl-details' }, v.details, ...details));
}

// ── /watchlist/ ─────────────────────────────────────────────────────────────────────────────
async function ownPage(root: HTMLElement): Promise<void> {
  const out = root.querySelector<HTMLElement>('[data-wl-body]')!;
  const signedOut = root.querySelector<HTMLElement>('[data-wl-signed-out]')!;
  const err = new URLSearchParams(location.search).get('signin');
  if (err) {
    const msg = err === 'cancelled' ? 'Sign-in was cancelled.' : err === 'expired' ? 'That sign-in link expired. Please try again.' : 'Sign-in did not complete. Please try again.';
    root.querySelector('[data-wl-msg]')?.append(h('p', { class: 'note', role: 'alert' }, msg));
  }
  const me = await loadMe();
  if (!me.available) { signedOut.hidden = false; signedOut.querySelector('[data-wl-off]')?.removeAttribute('hidden'); signedOut.querySelector('[data-wl-signin]')?.setAttribute('hidden', ''); return; }
  if (!me.signedIn) {
    signedOut.hidden = false;
    signedOut.querySelector<HTMLAnchorElement>('[data-wl-signin]')!.href = signInUrl('/watchlist/');
    return;
  }
  signedOut.hidden = true;
  out.hidden = false;
  await render(out, me);
}

async function render(out: HTMLElement, me: Me): Promise<void> {
  const lists = me.lists ?? [];
  const today = todayIso();
  const [feed, cards] = await Promise.all([
    api<Feed>('feed').catch(() => ({ changed: 0, items: [] }) as Feed),
    loadCards(lists.flatMap((l) => l.items.map((i) => ({ kind: i.kind, key: i.key, since: i.kind === 'search' ? since(i) : null })))),
  ]);
  const feedBy = new Map(feed.items.map((f) => [feedKey(f.list, f), f]));
  const total = lists.reduce((a, l) => a + l.items.length, 0);
  let current = lists.find((l) => l.id === getStored(LIST_KEY)) ?? lists[0];

  const reload = async (state?: Me): Promise<void> => {
    const next = state ? setMe(state) : await loadMe(true);
    await render(out, next);
  };
  const run = async (fn: () => Promise<Me | void>, ok?: string): Promise<void> => {
    try { const s = await fn(); await reload(s || undefined); if (ok) toast(ok); } catch (x) { toast((x as Error).message); }
  };

  // 1. what changed
  const reviewAll = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Mark all reviewed');
  reviewAll.addEventListener('click', () => void run(() => api<Me>('reviewed', {}), 'Everything marked reviewed.'));
  const changes = h('section', { 'aria-labelledby': 'wl-changes', class: 'wl-changes' },
    h('div', { class: 'wl-sec-head' }, h('h2', { id: 'wl-changes' }, feed.items.length ? `What changed since you last reviewed (${feed.items.length})` : 'What changed since you last reviewed'), feed.items.length ? reviewAll : null),
    feed.items.length ? h('div', { class: 'wl-change-list' }, ...feed.items.map((f) => changeBlock(f, lists, cards, run))) :
      h('p', { class: 'empty-reason' }, total
        ? 'Nothing has changed on the pages you follow since you last reviewed them. A change is a record the site has added, or a solicitation whose status, return-by date or quantity differs from when you followed it or last reviewed it.'
        : 'Follow a part, supplier, supply class, solicitation or agency with the Follow button on its page, or save an Open-demand search, and what changes will show here.'));

  // 2. lists
  const tabs = h('div', { class: 'chips wl-tabs', role: 'group', 'aria-label': 'Your lists' },
    ...lists.map((l) => {
      const changed = l.items.filter((i) => feedBy.has(feedKey(l.id, i))).length;
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(l.id === current?.id) }, l.name, h('span', { class: 'n' }, String(l.items.length)), changed ? h('span', { class: 'badge amber' }, String(changed)) : null);
      b.addEventListener('click', () => { setStored(LIST_KEY, l.id); current = l; void render(out, me); });
      return b;
    }));
  const newList = h('form', { class: 'wl-new-list' },
    h('label', { for: 'wl-new-name' }, 'New list'),
    h('input', { id: 'wl-new-name', name: 'name', maxlength: '80', placeholder: 'e.g. Fasteners, Navy buyers', required: true }),
    h('button', { type: 'submit', class: 'btn' }, 'Create'));
  newList.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (newList.querySelector('input') as HTMLInputElement).value.trim();
    if (name) void run(() => api<Me>('list', { name }), `Created "${name}".`);
  });
  const panel = current ? listPanel(current, lists, cards, feedBy, today, run) : null;

  // 3. the account
  const confirmInput = h('input', { id: 'wl-del-confirm', type: 'text', autocomplete: 'off', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm' });
  const delBtn = h('button', { type: 'submit', class: 'btn btn-ghost danger', disabled: true }, 'Delete my account');
  const delForm = h('form', { class: 'wl-delete', hidden: true }, h('label', { for: 'wl-del-confirm' }, 'This deletes your account, all your lists and your sign-in, and cannot be undone. Type DELETE to confirm.'), h('div', { class: 'row' }, confirmInput, delBtn));
  confirmInput.addEventListener('input', () => { delBtn.disabled = confirmInput.value.trim() !== 'DELETE'; });
  delForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (confirmInput.value.trim() !== 'DELETE') return;
    try { await api('delete-account', {}); location.href = '/?account=deleted'; } catch (x) { toast((x as Error).message); }
  });
  const showDel = h('button', { type: 'button', class: 'btn btn-ghost danger' }, 'Delete my account');
  showDel.addEventListener('click', () => { delForm.hidden = false; showDel.hidden = true; confirmInput.focus(); });
  const signOut = h('form', { method: 'post', action: '/auth/logout' }, h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Sign out'));
  const account = h('section', { 'aria-labelledby': 'wl-acct', class: 'wl-acct' },
    h('h2', { id: 'wl-acct' }, 'Your account'),
    h('p', {}, `Signed in${me.email ? ` as ${me.email}` : ''}. Your account holds your email address and your lists. `, h('a', { href: '/privacy/#accounts' }, 'What we keep and why'), '.'),
    h('div', { class: 'wl-actions' }, signOut, showDel), delForm);

  out.replaceChildren(
    h('p', { class: 'gloss' }, `Following ${total} ${total === 1 ? 'page' : 'pages'} in ${lists.length} ${lists.length === 1 ? 'list' : 'lists'}. Everything here restates public records; it is not advice.`),
    changes, h('h2', { id: 'wl-lists', class: 'section-title' }, 'Your lists'), tabs, ...(panel ? [panel] : []), newList, account);
}

function changeBlock(f: FeedItem, lists: ListState[], cards: Cards, run: (fn: () => Promise<Me | void>, ok?: string) => Promise<void>): HTMLElement {
  const list = lists.find((l) => l.id === f.list);
  const it = list?.items.find((i) => i.kind === f.kind && i.key === f.key);
  const btn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Mark reviewed');
  btn.setAttribute('aria-label', `Mark ${f.label ?? f.key} reviewed`);
  btn.addEventListener('click', () => void run(() => api<Me>('reviewed', { list: f.list, kind: f.kind, key: f.key })));
  return h('article', { class: 'wl-change', 'data-kind': f.kind, 'data-key': f.key },
    h('div', { class: 'wl-change-head' },
      h('span', { class: 'wl-kind' }, KIND_LABEL[f.kind]),
      h('a', { class: 'wl-name', href: itemHref(f, cards[cardKey(f)]) }, f.label || itemName({ kind: f.kind, key: f.key, label: null })),
      h('span', { class: 'soft' }, `${changeCount(f.count)} since ${when(since(it ?? { kind: f.kind, key: f.key, label: null, added_at: f.since }))}`),
      lists.length > 1 && list ? h('span', { class: 'tag' }, list.name) : null,
      btn),
    h('ul', { class: 'wl-events' }, ...f.events.map((e) => h('li', {},
      h('span', { class: 'when' }, when(e.at)),
      h('span', { class: 'what' }, h('b', {}, `${EVENT_LABEL[e.type]}. `), eventText(f.kind, e)),
      e.url ? h('a', { href: e.url, rel: 'noopener nofollow', target: '_blank' }, 'Source') : h('span', {}, '')))),
    f.count > f.events.length ? h('p', { class: 'k' }, f.count >= 100 && f.events.length < 100 ? `${f.events.length} of 100 or more shown. ` : `${f.count - f.events.length} more. `, h('a', { href: itemHref(f, cards[cardKey(f)]) }, 'Open the page')) : null);
}

function listPanel(l: ListState, all: ListState[], cards: Cards, feedBy: Map<string, FeedItem>, today: string,
  run: (fn: () => Promise<Me | void>, ok?: string) => Promise<void>): HTMLElement {
  const shareUrl = l.slug ? `${location.origin}/watchlist/shared/#${l.slug}` : '';
  const rows = l.items.map((i) => {
    const fi = feedBy.get(feedKey(l.id, i));
    const others = all.filter((o) => o.id !== l.id);
    const move = others.length ? h('select', { 'aria-label': `Move ${i.label ?? i.key} to another list` }, h('option', { value: '' }, 'Move to…'), ...others.map((o) => h('option', { value: o.id }, o.name))) : null;
    move?.addEventListener('change', () => { const to = move.value; if (to) void run(() => api<Me>('move', { kind: i.kind, key: i.key, from: l.id, to })); });
    const rm = h('button', { type: 'button', class: 'btn-quiet' }, 'Remove');
    rm.setAttribute('aria-label', `Remove ${i.label ?? i.key}`);
    rm.addEventListener('click', () => void run(() => api<Me>('follow', { kind: i.kind, key: i.key, on: false, list: l.id })));
    const mark = fi ? h('button', { type: 'button', class: 'btn-quiet' }, 'Mark reviewed') : null;
    mark?.setAttribute('aria-label', `Mark ${i.label ?? i.key} reviewed`);
    mark?.addEventListener('click', () => void run(() => api<Me>('reviewed', { list: l.id, kind: i.kind, key: i.key })));
    const noteBtn = h('button', { type: 'button', class: 'btn-quiet' }, i.note ? 'Edit note' : 'Add note');
    const noteBox = h('form', { class: 'wl-note-edit', hidden: true },
      h('input', { type: 'text', maxlength: '500', value: i.note ?? '', 'aria-label': `Note on ${i.label ?? i.key}` }), h('button', { type: 'submit', class: 'btn' }, 'Save'));
    noteBtn.addEventListener('click', () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteBox.querySelector('input')?.focus(); });
    noteBox.addEventListener('submit', (e) => { e.preventDefault(); void run(() => api<Me>('note', { list: l.id, kind: i.kind, key: i.key, note: (noteBox.querySelector('input') as HTMLInputElement).value })); });
    return itemRow(l, i, cards, fi, h('span', { class: 'wl-item-actions' }, mark, noteBtn, move, rm), ([i.note ? h('p', { class: 'wl-note' }, h('b', {}, 'Your note: '), i.note) : null, noteBox] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x));
  });

  const rename = h('button', { type: 'button', class: 'btn-quiet' }, 'Rename');
  const renameForm = h('form', { class: 'wl-rename', hidden: true }, h('input', { type: 'text', maxlength: '80', value: l.name, 'aria-label': 'List name', required: true }), h('button', { type: 'submit', class: 'btn' }, 'Save'));
  rename.addEventListener('click', () => { renameForm.hidden = !renameForm.hidden; if (!renameForm.hidden) renameForm.querySelector('input')?.focus(); });
  renameForm.addEventListener('submit', (e) => { e.preventDefault(); const name = (renameForm.querySelector('input') as HTMLInputElement).value.trim(); if (name && name !== l.name) void run(() => api<Me>('list', { id: l.id, name })); });
  const share = h('button', { type: 'button', class: 'btn-quiet', 'aria-pressed': String(l.is_public) }, l.is_public ? 'Stop sharing' : 'Share with a link');
  share.addEventListener('click', () => void run(() => api<Me>('list', { id: l.id, public: !l.is_public }), l.is_public ? 'Sharing stopped. The old link no longer works.' : 'Anyone with the link can now see this list.'));
  const del = l.is_default ? null : h('button', { type: 'button', class: 'btn-quiet danger' }, 'Delete list');
  del?.addEventListener('click', () => { if (confirm(`Delete "${l.name}"? This cannot be undone.`)) void run(() => api<Me>('list', { id: l.id, delete: true })); });
  const reviewList = l.items.some((i) => feedBy.has(feedKey(l.id, i))) ? h('button', { type: 'button', class: 'btn-quiet' }, 'Mark list reviewed') : null;
  reviewList?.addEventListener('click', () => void run(() => api<Me>('reviewed', { list: l.id }), 'List marked reviewed.'));
  const csv = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Download CSV');
  csv.addEventListener('click', () => {
    const text = watchCsv(location.origin, l.items.map((i) => ({ list: l.name, item: i, card: cards[cardKey(i)], feed: feedBy.get(feedKey(l.id, i)) })), today);
    csvDownload(`nsn-explorer-${slugName(l.name)}-${today}.csv`, text);
  });
  const link = shareUrl ? h('div', { class: 'share-link wl-share' },
    h('input', { type: 'text', readonly: true, value: shareUrl, 'aria-label': `Link to ${l.name}` }),
    (() => { const c = h('button', { type: 'button', class: 'btn' }, 'Copy link'); c.addEventListener('click', () => { navigator.clipboard?.writeText(shareUrl).then(() => toast('Link copied.'), () => toast(shareUrl)); }); return c; })()) : null;

  return h('section', { class: 'card wl-list', 'aria-label': l.name },
    h('div', { class: 'wl-list-head' },
      h('h3', {}, l.name, l.is_public ? h('span', { class: 'tag' }, 'Shared') : null),
      h('span', { class: 'wl-item-actions' }, reviewList, rename, share, del, csv)),
    renameForm, link,
    rows.length ? h('ul', { class: 'wl-items' }, ...rows) : h('p', { class: 'empty-reason' }, 'Nothing here yet. Use the Follow button on a part, supplier, supply class, solicitation or agency page, or Save this search on an Open-demand page.'));
}

// ── /watchlist/shared/#<slug> ───────────────────────────────────────────────────────────────
interface Shared { name: string; updated_at: string; items: Item[] }
async function sharedPage(root: HTMLElement): Promise<void> {
  const out = root.querySelector<HTMLElement>('[data-wl-shared]')!;
  const slug = location.hash.slice(1);
  if (!/^[a-z0-9]{12}$/.test(slug)) { out.replaceChildren(h('p', { class: 'empty-reason' }, 'This link is incomplete. Ask whoever shared it to copy it again.')); return; }
  let list: Shared;
  try { list = await api<Shared>(`public?slug=${slug}`); } catch (x) { out.replaceChildren(h('p', { class: 'empty-reason' }, (x as Error).message)); return; }
  document.title = `${list.name} — shared watchlist · NSN Explorer`;
  const cards = await loadCards(list.items);
  const copy = h('button', { type: 'button', class: 'btn' }, 'Copy to my watchlist');
  copy.addEventListener('click', async () => {
    const me = await loadMe();
    if (!me.signedIn) { location.href = signInUrl(`/watchlist/shared/#${slug}`); return; }
    try { setMe(await api<Me>('copy', { slug })); toast(`Copied. It is on your watchlist as "Copy of ${list.name}".`); } catch (x) { toast((x as Error).message); }
  });
  const csv = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Download CSV');
  csv.addEventListener('click', () => csvDownload(`nsn-explorer-${slugName(list.name)}-${todayIso()}.csv`, watchCsv(location.origin, list.items.map((i) => ({ list: list.name, item: i, card: cards[cardKey(i)] })), todayIso())));
  out.replaceChildren(
    h('h2', {}, list.name),
    h('p', { class: 'gloss' }, `${list.items.length} ${list.items.length === 1 ? 'page' : 'pages'} followed. Shared by an NSN Explorer visitor: the list shows what they chose to follow, not advice.`),
    h('div', { class: 'wl-actions' }, copy, csv),
    list.items.length ? h('ul', { class: 'wl-items' }, ...list.items.map((i) => itemRow({ id: '', name: list.name }, i, cards, undefined, null))) : h('p', { class: 'empty-reason' }, 'This list is empty.'));
}

export { CSV_BOM };
const own = document.querySelector<HTMLElement>('[data-watchlist]');
if (own) void ownPage(own);
const shared = document.querySelector<HTMLElement>('[data-watchlist-shared]');
if (shared) { void sharedPage(shared); window.addEventListener('hashchange', () => void sharedPage(shared)); }
