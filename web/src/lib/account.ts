// Accounts, follows and watchlists (2026-10-11) — the pure parts, shared by the Pages Function
// routes (src/pages/auth/*, src/pages/api/me.ts, src/pages/api/account/[action].ts), the page
// scripts and the unit tests (account.test.ts). Nothing here touches the network.
//
// How the pieces fit:
//   sign-in   WorkOS AuthKit's hosted page -> /auth/callback -> an encrypted session cookie
//             (COOKIE, HttpOnly) plus a harmless SIGNED_IN flag cookie page scripts can read, so
//             anonymous visitors never call the Function at all.
//   data      Supabase PostgREST over HTTPS (never Hyperdrive), through the functions in
//             db/migrations/0009_accounts_watchlists.sql, called with the visitor's own WorkOS
//             access token: row-level security decides what each call can touch.
//   pages     stay static (or edge-cached). Follow buttons and the header's watchlist link are
//             filled in by src/scripts/account.ts from GET /api/me.

/** True when the PUBLIC_ACCOUNTS_FORCE=1 build variable is set; the local verifiers build that way. */
function forcedOn(): boolean {
  try { return import.meta.env.PUBLIC_ACCOUNTS_FORCE === '1'; } catch { return false; }
}

/**
 * Master switch for the Follow buttons, the header's watchlist link and the sign-in routes.
 * FALSE until the WorkOS and Supabase settings in docs/accounts-setup.md are in place; then flip
 * it to true in this file. While false: no Follow buttons, no header link, /watchlist/ says
 * accounts are coming, and /auth/* answers 404.
 */
export const ACCOUNTS_ENABLED: boolean = true || forcedOn();

export const COOKIE = 'nsn_session';
export const SIGNED_IN = 'nsn_signed_in';
export const STATE_COOKIE = 'nsn_oauth_state';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days; WorkOS refreshes the tokens inside it

/** Paths whose responses are about one visitor: never cached, anywhere. */
export const ACCOUNT_PATH = /^\/(auth(\/|$)|api\/(me|account)(\/|$))/;
export const isAccountPath = (pathname: string): boolean => ACCOUNT_PATH.test(pathname);

// ── what can be followed ───────────────────────────────────────────────────────────────────
export type Kind = 'nsn' | 'supplier' | 'manufacturer' | 'fsc' | 'solicitation' | 'agency' | 'search';
export const KINDS: readonly Kind[] = ['nsn', 'supplier', 'manufacturer', 'fsc', 'solicitation', 'agency', 'search'];
export const KIND_LABEL: Record<Kind, string> = {
  nsn: 'Part (NSN)',
  supplier: 'Supplier',
  manufacturer: 'Manufacturer',
  fsc: 'Supply class',
  solicitation: 'Solicitation',
  agency: 'Agency',
  search: 'Saved search',
};

const dash = (nsn: string): string => `${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9)}`;

/** The page a watchlist item points to. Keys are the same codes the URLs use. */
export function itemPath(kind: Kind, key: string): string {
  switch (kind) {
    case 'nsn': return `/nsn/${dash(key)}/`;
    case 'supplier':
    case 'manufacturer': return `/supplier/${encodeURIComponent(key)}/`;
    case 'fsc': return `/fsc/${encodeURIComponent(key)}/`;
    case 'solicitation': return `/solicitation/${encodeURIComponent(key)}/`;
    case 'agency': return `/agency/${encodeURIComponent(key)}/`;
    case 'search': {
      const m = /(?:^|;)fsc=([a-z0-9]{4})(?:;|$)/.exec(key);
      return `${m ? `/open/${m[1].toUpperCase()}/` : '/open/'}${key === 'all' ? '' : `#search=${key}`}`;
    }
  }
}

// Key rules, the same as watch_norm() in the migration.
const KEY_RULES: Record<Kind, { re: RegExp; fix: (k: string) => string }> = {
  nsn: { re: /^[0-9]{13}$/, fix: (k) => k.replace(/-/g, '') },
  supplier: { re: /^[A-Z0-9]{5}$/, fix: (k) => k.toUpperCase() },
  manufacturer: { re: /^[A-Z0-9]{5}$/, fix: (k) => k.toUpperCase() },
  fsc: { re: /^[A-Z0-9]{4}$/, fix: (k) => k.toUpperCase() },
  solicitation: { re: /^[A-Za-z0-9-]{1,80}$/, fix: (k) => k },
  agency: { re: /^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$/, fix: (k) => k.toLowerCase() },
  search: { re: /^(all|(fsc=[a-z0-9]{4}|closes=[0-9]{1,3}|minqty=[0-9]{1,9}|comp=(open|restricted))(;(fsc=[a-z0-9]{4}|closes=[0-9]{1,3}|minqty=[0-9]{1,9}|comp=(open|restricted)))*)$/, fix: (k) => k.toLowerCase() },
};
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
/** The normalized key, or null when it is not a key of that kind. */
export function normKey(kind: Kind, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const r = KEY_RULES[kind];
  const k = r.fix(raw.trim());
  return r.re.test(k) ? k : null;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const isSlug = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9]{12}$/.test(v);

/**
 * Where to send someone after sign-in or sign-out. Only a path on this site: an absolute URL,
 * a protocol-relative "//evil.example" or a backslash trick falls back to the watchlist page.
 */
export function safeReturnPath(raw: string | null | undefined, fallback = '/watchlist/'): string {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return fallback;
  if (raw.startsWith('/auth/') || raw.startsWith('/api/')) return fallback;
  return raw;
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export interface CookieOpts { maxAge: number; httpOnly?: boolean; path?: string }
/** A Set-Cookie value. Always Secure and SameSite=Lax: a cross-site POST never carries it. */
export function setCookie(name: string, value: string, o: CookieOpts): string {
  return `${name}=${encodeURIComponent(value)}; Path=${o.path ?? '/'}; Max-Age=${Math.max(0, Math.floor(o.maxAge))}; Secure; SameSite=Lax${o.httpOnly === false ? '' : '; HttpOnly'}`;
}
export const clearCookie = (name: string, httpOnly = true): string => setCookie(name, '', { maxAge: 0, httpOnly });

/**
 * A POST that changes something must come from the page's own origin (scheme + host of the
 * request itself, so www and the bare domain each pass for themselves). Browsers send Origin on
 * every POST; a request without one, or from another origin, is refused. The session cookie is
 * SameSite=Lax already; this is the second lock on the same door.
 */
export function sameOrigin(origin: string | null, own: string): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(own).origin; } catch { return false; }
}

// ── the API ────────────────────────────────────────────────────────────────────────────────
/**
 * The actions the site's scripts may call at /api/account/<action>, each mapped to one database
 * function and the only arguments it may pass. Anything not listed is a 404; any argument that
 * fails its check is a 400 before the database is asked. `anon: true` actions work without a
 * sign-in (public records only).
 */
export type Action = {
  method: 'GET' | 'POST';
  fn: string;
  anon?: boolean;
  args: (input: Record<string, unknown>) => Record<string, unknown> | string;
};
const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
const kindKey = (b: Record<string, unknown>): { kind: Kind; key: string } | string => {
  if (!isKind(b.kind)) return 'Unknown kind.';
  const key = normKey(b.kind, b.key);
  return key ? { kind: b.kind, key } : 'Bad key.';
};
export const MAX_CARD_ITEMS = 200;

export const ACTIONS: Record<string, Action> = {
  feed: { method: 'GET', fn: 'watch_feed', args: () => ({ p_per: 8 }) },
  follow: {
    method: 'POST', fn: 'follow', args: (b) => {
      const k = kindKey(b);
      if (typeof k === 'string') return k;
      if (b.list != null && !isUuid(b.list)) return 'Bad list.';
      return { p_kind: k.kind, p_key: k.key, p_label: str(b.label, 200), p_on: b.on !== false, p_list: b.list ?? null };
    },
  },
  list: {
    method: 'POST', fn: 'list_save', args: (b) => {
      if (b.id != null && !isUuid(b.id)) return 'Bad list.';
      const name = str(b.name, 80);
      if (b.id == null && !name) return 'A new list needs a name.';
      return { p_id: b.id ?? null, p_name: name, p_public: typeof b.public === 'boolean' ? b.public : null, p_delete: b.delete === true };
    },
  },
  move: {
    method: 'POST', fn: 'item_move', args: (b) => {
      const k = kindKey(b);
      if (typeof k === 'string') return k;
      if (!isUuid(b.from) || !isUuid(b.to)) return 'Bad move.';
      return { p_kind: k.kind, p_key: k.key, p_from: b.from, p_to: b.to };
    },
  },
  note: {
    method: 'POST', fn: 'item_note', args: (b) => {
      const k = kindKey(b);
      if (typeof k === 'string') return k;
      if (!isUuid(b.list)) return 'Bad list.';
      return { p_list: b.list, p_kind: k.kind, p_key: k.key, p_note: typeof b.note === 'string' ? b.note.slice(0, 500) : null };
    },
  },
  reviewed: {
    method: 'POST', fn: 'mark_reviewed', args: (b) => {
      if (b.list != null && !isUuid(b.list)) return 'Bad list.';
      if (b.kind == null && b.key == null) return { p_list: b.list ?? null, p_kind: null, p_key: null };
      const k = kindKey(b);
      return typeof k === 'string' ? k : { p_list: b.list ?? null, p_kind: k.kind, p_key: k.key };
    },
  },
  copy: { method: 'POST', fn: 'list_copy', args: (b) => (isSlug(b.slug) ? { p_slug: b.slug } : 'Bad link.') },
  cards: {
    method: 'POST', fn: 'watch_cards', anon: true, args: (b) => {
      if (!Array.isArray(b.items)) return 'Bad items.';
      if (b.items.length > MAX_CARD_ITEMS) return `Ask for at most ${MAX_CARD_ITEMS} items at a time.`;
      const items: { kind: Kind; key: string; since?: string }[] = [];
      for (const raw of b.items as Record<string, unknown>[]) {
        const k = raw && typeof raw === 'object' ? kindKey(raw) : 'Bad item.';
        if (typeof k === 'string') return k;
        const since = typeof raw.since === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(raw.since) ? raw.since : undefined;
        items.push(since ? { ...k, since } : k);
      }
      return { items };
    },
  },
};

// ── shapes the database returns ────────────────────────────────────────────────────────────
export interface Item { kind: Kind; key: string; label: string | null; note?: string | null; added_at?: string; reviewed_at?: string | null }
export interface ListState { id: string; name: string; is_default: boolean; is_public: boolean; slug: string | null; items: Item[] }
export interface Me {
  signedIn: boolean; available: boolean; email?: string | null; new_count?: number; account?: { email: string | null; created_at: string };
  lists?: ListState[];
}
export const itemId = (i: { kind: string; key: string }): string => `${i.kind}:${i.key}`;
