// item-search.ts: pure helpers for "find a part by name" (the /search/ page, /api/names.json and the
// name section of the site search dialog). No DOM, no database and no sibling imports, so node --test
// loads it directly and the browser bundle can use it too. The SQL lives in item-search-sql.ts.

/** Longest query text we look at; anything past this is dropped before it reaches the database. */
export const NAME_QUERY_MAX_CHARS = 60;
/** At most this many words are searched on (the SQL has one parameter per word). */
export const NAME_QUERY_MAX_WORDS = 4;
/** A word must be at least this long to narrow the search (shorter words cannot use the trigram index). */
export const NAME_WORD_MIN = 3;
/** Rows per page on the results page and in the API. */
export const NAME_PAGE_SIZE = 25;
/** Largest `n` the results page honours (top 200). */
export const NAME_MAX_ROWS = 200;
/** Rows shown in the search dialog before "See all". */
export const NAME_DIALOG_ROWS = 6;

export type NameQuery =
  | {
      ok: true;
      /** Lower-case letters and digits, single spaces: what the ranking compares against. */
      phrase: string;
      /** The same words in reverse order, so "lock washer" also finds the catalog's "WASHER,LOCK". */
      reversed: string;
      /** Words of three or more characters, at most NAME_QUERY_MAX_WORDS, padded with null to that length. */
      words: (string | null)[];
    }
  | { ok: false; reason: 'empty' | 'short' | 'no_letters' };

/**
 * Turns what the person typed into the only text the SQL ever sees: letters, digits and single spaces.
 * Every other character (the LIKE wildcards % and _, backslash, quotes, punctuation, hyphens, commas,
 * control characters) becomes a space, so nothing the person types can act as a pattern. A hyphenated
 * name such as "o-ring" is searched as the words "o" and "ring", which is also how the catalog names
 * are compared.
 */
export function parseNameQuery(raw: unknown): NameQuery {
  const text = String(raw ?? '')
    .slice(0, NAME_QUERY_MAX_CHARS * 2)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, NAME_QUERY_MAX_CHARS)
    .trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (!/[a-z]/.test(text)) return { ok: false, reason: 'no_letters' };
  const all = text.split(' ').slice(0, NAME_QUERY_MAX_WORDS);
  const long = all.filter((w) => w.length >= NAME_WORD_MIN);
  if (long.length === 0) return { ok: false, reason: 'short' };
  const words: (string | null)[] = long.slice(0, NAME_QUERY_MAX_WORDS);
  while (words.length < NAME_QUERY_MAX_WORDS) words.push(null);
  return { ok: true, phrase: all.join(' '), reversed: [...all].reverse().join(' '), words };
}

/** Message for a query that cannot be searched; empty string when it can. */
export function nameQueryProblem(reason: 'empty' | 'short' | 'no_letters'): string {
  if (reason === 'empty') return 'Type a part name, such as lock washer or o-ring.';
  if (reason === 'short') return 'Type at least three letters of a part name.';
  return 'That is only numbers. For an NSN, a NIIN or a part number, use the search box in the header.';
}

/** Integer query parameter clamped to [min, max]; anything that is not a whole number gives `fallback`. */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,6}$/.test(s)) return fallback;
  return Math.min(max, Math.max(min, Number(s)));
}

/** Rows to show on the results page for `?n=`: a multiple of the page size between 25 and 200. */
export function rowsFromParam(raw: unknown): number {
  const n = clampInt(raw, NAME_PAGE_SIZE, NAME_PAGE_SIZE, NAME_MAX_ROWS);
  return Math.ceil(n / NAME_PAGE_SIZE) * NAME_PAGE_SIZE;
}

/** URL of the results page. The search text is the only thing in the URL. */
export function searchPageUrl(q: string, rows: number = NAME_PAGE_SIZE): string {
  const base = `/search/?q=${encodeURIComponent(q.trim().slice(0, NAME_QUERY_MAX_CHARS))}`;
  return rows > NAME_PAGE_SIZE ? `${base}&n=${rows}` : base;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 2026" from an ISO date or timestamp, or null. */
export function monthYearLabel(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : null;
}

/** "1 open solicitation" / "3 open solicitations" / "Last award Mar 2026" / "". */
export function demandLabel(open: number, lastAward: string | null | undefined): string {
  if (open > 0) return `${open.toLocaleString('en-US')} open ${open === 1 ? 'solicitation' : 'solicitations'}`;
  const when = monthYearLabel(lastAward);
  return when ? `Last award ${when}` : '';
}

/**
 * Catalog names are upper case and inverted ("WASHER,LOCK"). Shown as the site shows them on the NSN page:
 * title case, comma then space. Mirrors nomen() in seo-copy.ts for the cases that matter here, but
 * lives in this file so the browser bundle and node --test need no other module.
 */
export function displayName(raw: string | null | undefined): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return 'Unnamed item';
  return t
    .replace(/\s*,\s*/g, ', ')
    .replace(/[A-Za-z0-9']+/g, (tok) => {
      if (/\d/.test(tok)) return tok.toUpperCase();
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .replace(/,\s*$/, '');
}

const wordsOf = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * The everyday name worth showing under an item name, or null. An everyday name whose words are all already
 * in the item name ("WASHER" for "WASHER,6 INCH", "WASHER LOCK" for "WASHER,LOCK") says nothing new, so it is
 * not shown; "GRIP WASHER" for "WASHER,LOCK" is.
 */
export function alsoCalledFor(itemName: string | null | undefined, alias: string | null | undefined): string | null {
  const a = wordsOf(alias ?? '');
  if (a.length === 0) return null;
  const have = new Set(wordsOf(itemName ?? ''));
  return a.every((w) => have.has(w)) ? null : (alias ?? '').trim();
}

export interface NameHit {
  /** Dashed NSN, e.g. 5310-00-045-3299. */
  nsn: string;
  /** Item name as the catalog writes it. */
  name: string;
  fsc: string;
  fscName: string | null;
  /** The everyday name that matched, when the match came from one and not from the item name. */
  alsoCalled: string | null;
  open: number;
  lastAward: string | null;
}

export interface NameSearchResult {
  ok: boolean;
  query: string;
  total: number;
  offset: number;
  results: NameHit[];
  /** True when more rows exist beyond offset + results.length. */
  more: boolean;
  error?: string;
}

/** One line under the item name: class, then demand. */
export function hitMeta(h: Pick<NameHit, 'fsc' | 'fscName' | 'open' | 'lastAward'>): string {
  const cls = h.fscName ? `Class ${h.fsc} ${h.fscName}` : `Class ${h.fsc}`;
  const demand = demandLabel(h.open, h.lastAward);
  return demand ? `${cls} · ${demand}` : cls;
}
