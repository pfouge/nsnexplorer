// Accounts on static and edge-cached pages: the header's watchlist button and badge, and every
// Follow button. Pages stay as they are; this script asks the Function who the visitor is only
// when the readable `nsn_signed_in` cookie says they signed in, so anonymous visitors cost nothing.
//
// Signed out + Follow: the intent is kept in sessionStorage (this tab only), the visitor signs in
// on WorkOS's page, comes back to the same page, and the follow happens then.

import { ACCOUNTS_ENABLED, SIGNED_IN, type Kind, type Me } from '../lib/account';

export type { Me };

const INTENT = 'nsn_follow_intent';
const signedInHint = (): boolean => document.cookie.split(';').some((c) => c.trim() === `${SIGNED_IN}=1`);

// One /api/me request at a time per page. Two at once (the header script and the watchlist page
// both asking on load) could both refresh an expired session with the same single-use refresh
// token; see getSession() in src/lib/server/session.ts. `force` re-asks only once the request in
// flight, if any, has finished.
let mePromise: Promise<Me> | null = null;
let meInFlight = false;
export function loadMe(force = false): Promise<Me> {
  if (!ACCOUNTS_ENABLED) return Promise.resolve({ signedIn: false, available: false });
  if (mePromise && (!force || meInFlight)) return mePromise;
  meInFlight = true;
  mePromise = (signedInHint()
    ? fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : { signedIn: false, available: true }))
        .catch(() => ({ signedIn: false, available: true }))
    : Promise.resolve({ signedIn: false, available: true })
  ).finally(() => { meInFlight = false; }) as Promise<Me>;
  return mePromise;
}
/** Use a fresh state the server just returned (follow, list change, review) as the page's state. */
export function setMe(state: Partial<Me>): Me {
  const me = { ...state, signedIn: true, available: true } as Me;
  mePromise = Promise.resolve(me);
  paintHeader(me);
  paintFollow(me);
  document.dispatchEvent(new CustomEvent('nsn:me', { detail: me }));
  return me;
}

export async function api<T = unknown>(action: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/account/${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? 'Something went wrong. Please try again.');
  return data as T;
}

export const signInUrl = (returnTo = location.pathname + location.search + location.hash): string =>
  `/auth/login?return=${encodeURIComponent(returnTo)}`;

export function toast(text: string): void {
  let el = document.getElementById('acctToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'acctToast'; el.className = 'acct-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('on');
  window.clearTimeout(Number(el.dataset.t ?? 0));
  el.dataset.t = String(window.setTimeout(() => el!.classList.remove('on'), 3500));
}

export function isFollowed(me: Me, kind: string, key: string): boolean {
  return !!me.lists?.some((l) => l.items.some((i) => i.kind === kind && i.key === key));
}

function paintHeader(me: Me): void {
  const btn = document.getElementById('acctBtn');
  if (!btn) return;
  btn.hidden = !me.available;   // shown unless the server says accounts are not set up
  const badge = btn.querySelector<HTMLElement>('.acct-badge');
  const n = me.signedIn ? me.new_count ?? 0 : 0;
  if (badge) { badge.hidden = n === 0; badge.textContent = n > 99 ? '99+' : String(n); }
  btn.setAttribute('aria-label', me.signedIn ? (n ? `Watchlist, ${n} ${n === 1 ? 'item' : 'items'} changed` : 'Watchlist') : 'Watchlist (sign in)');
}

function paintFollow(me: Me): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-follow]')) {
    if (!me.available) { b.hidden = true; continue; }
    const on = me.signedIn && isFollowed(me, b.dataset.kind!, b.dataset.key!);
    b.hidden = false;
    b.setAttribute('aria-pressed', String(on));
    const t = b.querySelector('[data-follow-text]');
    if (t) t.textContent = on ? b.dataset.textOn ?? 'Following' : b.dataset.textOff ?? 'Follow';
    b.title = on ? 'Remove from your watchlist' : 'Add to your watchlist';
  }
}

async function setFollow(b: HTMLButtonElement, on: boolean): Promise<void> {
  b.disabled = true;
  try {
    const me = await api<Me>('follow', { kind: b.dataset.kind, key: b.dataset.key, label: b.dataset.label, on });
    setMe(me);
    toast(on ? `Following ${b.dataset.label}. Changes will show on your watchlist.` : `Stopped following ${b.dataset.label}.`);
  } catch (e) {
    toast((e as Error).message);
  } finally { b.disabled = false; }
}

/** Follow / unfollow from code (the saved-search button): signs the visitor in first when needed. */
export async function followItem(kind: Kind, key: string, label: string, on: boolean): Promise<boolean> {
  const me = await loadMe();
  if (!me.signedIn) {
    try { sessionStorage.setItem(INTENT, JSON.stringify({ kind, key, label, path: location.pathname + location.search + location.hash })); } catch { /* still signs in */ }
    location.href = signInUrl();
    return false;
  }
  try {
    setMe(await api<Me>('follow', { kind, key, label, on }));
    return true;
  } catch (e) { toast((e as Error).message); return false; }
}

async function init(): Promise<void> {
  const me = await loadMe();
  paintHeader(me);
  paintFollow(me);
  document.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-follow]');
    if (!b) return;
    const now = await loadMe();
    if (!now.signedIn) {
      try { sessionStorage.setItem(INTENT, JSON.stringify({ kind: b.dataset.kind, key: b.dataset.key, label: b.dataset.label, path: location.pathname })); } catch { /* still signs in */ }
      location.href = signInUrl();
      return;
    }
    await setFollow(b, b.getAttribute('aria-pressed') !== 'true');
  });
  // Back from signing in with a Follow pending on this page: do it now.
  let intent: { kind?: string; key?: string; label?: string; path?: string } | null = null;
  try { intent = JSON.parse(sessionStorage.getItem(INTENT) ?? 'null'); sessionStorage.removeItem(INTENT); } catch { intent = null; }
  if (intent && me.signedIn && intent.kind && intent.key && (intent.path ?? '').split(/[?#]/)[0] === location.pathname) {
    const b = [...document.querySelectorAll<HTMLButtonElement>('[data-follow]')].find((x) => x.dataset.kind === intent!.kind && x.dataset.key === intent!.key);
    if (b) { if (b.getAttribute('aria-pressed') !== 'true') await setFollow(b, true); }
    else if (intent.kind === 'search' && !isFollowed(me, 'search', intent.key)) {
      // the saved-search button is not a [data-follow]; save it directly
      try { setMe(await api<Me>('follow', { kind: 'search', key: intent.key, label: intent.label, on: true })); toast('Search saved. New solicitations that match will show on your watchlist.'); } catch (e) { toast((e as Error).message); }
    }
  }
}

if (ACCOUNTS_ENABLED) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
  else void init();
}
