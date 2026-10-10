// Pure helpers for the supplier (/supplier/<CAGE>/) and solicitation
// (/solicitation/<number>/) pages: identifier validation, title / lede /
// description copy, and the supplier-search query rules. No I/O and no imports
// beyond seo-copy (itself pure), so it runs unchanged in the Workers runtime,
// at build time and under `node --test`.
//
// Every sentence produced here is a plain statement of what the records show:
// counts, dates and names, with no adjectives, advice or ranking.

import { fitDescription, monthYear } from './seo-copy.ts';

// ---------------------------------------------------------------------------
// Identifiers

/** A CAGE code: exactly five characters, A-Z and 0-9. */
export const CAGE_RE = /^[A-Z0-9]{5}$/;

/** Letters, digits and dashes only (DIBBS RFQ numbers and SAM.gov notice ids). */
export const SOL_NUMBER_RE = /^[A-Za-z0-9-]{1,80}$/;

export const isCage = (v: string): boolean => CAGE_RE.test(v);
export const isSolNumber = (v: string | null | undefined): v is string => typeof v === 'string' && SOL_NUMBER_RE.test(v);

export type CageParam = { kind: 'ok'; cage: string } | { kind: 'redirect'; cage: string } | { kind: 'invalid' };

/**
 * Classifies the [cage] route parameter: canonical (upper case), a lower-case
 * spelling that redirects to the canonical URL, or not a CAGE at all.
 */
export function parseCageParam(raw: string): CageParam {
  if (CAGE_RE.test(raw)) return { kind: 'ok', cage: raw };
  const up = raw.toUpperCase();
  if (CAGE_RE.test(up)) return { kind: 'redirect', cage: up };
  return { kind: 'invalid' };
}

/** Site-relative URL of a solicitation page, or null when the number is not URL-safe. */
export const solicitationPath = (sol: string | null | undefined): string | null => (isSolNumber(sol) ? `/solicitation/${sol}/` : null);

/** Site-relative URL of a supplier page, or null when the value is not a CAGE. */
export const supplierPath = (cage: string | null | undefined): string | null => {
  const c = (cage ?? '').trim();
  return CAGE_RE.test(c) ? `/supplier/${c}/` : null;
};

// ---------------------------------------------------------------------------
// Copy

const int = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string = `${one}s`): string => `${int(n)} ${n === 1 ? one : many}`;
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Longest title (before the " · NSN Explorer" suffix the SEO component appends). */
export const MAX_TITLE = 60;
/** Longest meta description. */
export const MAX_SUPPLIER_DESCRIPTION = 155;

/**
 * Shortens a name to at most `max` characters, cutting at a word boundary when
 * one falls in the back half and ending with an ellipsis. Names that already
 * fit are returned unchanged (whitespace collapsed).
 */
export function trimName(name: string, max: number): string {
  const n = squash(name);
  if (n.length <= max) return n;
  const room = Math.max(1, max - 1);
  let cut = n.slice(0, room);
  const space = cut.lastIndexOf(' ');
  if (space >= room / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.&/-]+$/, '')}…`;
}

const cleanName = (name: string | null | undefined): string | null => {
  const n = squash(name ?? '');
  return n === '' ? null : n;
};

/** `{Name} (CAGE 1ABC2): Government Parts Awards`, the name trimmed so the title is at most 60 characters. */
export function supplierTitle(name: string | null | undefined, cage: string): string {
  const n = cleanName(name);
  if (!n) return `CAGE ${cage}: Government Parts Awards`;
  const tail = ` (CAGE ${cage}): Government Parts Awards`;
  return `${trimName(n, MAX_TITLE - tail.length)}${tail}`;
}

export interface SupplierCopyInput {
  cage: string;
  name: string | null;
  awards: number;
  classes: number;
  /** ISO date of the most recent award, or null. */
  latest: string | null;
}

const subject = (name: string | null, cage: string): string => (name ? `${name} (CAGE ${cage})` : `CAGE ${cage}`);

/** The one-sentence summary under the H1: facts from the records only. */
export function supplierLede(i: SupplierCopyInput, nameMax = Infinity): string {
  const n = cleanName(i.name);
  const who = subject(n ? trimName(n, nameMax) : null, i.cage);
  const when = monthYear(i.latest);
  return (
    `${who} appears as the awardee on ${plural(i.awards, 'indexed government parts award')} ` +
    `across ${plural(i.classes, 'federal supply class', 'federal supply classes')}${when ? `, most recently in ${when}` : ''}.`
  );
}

/** Meta description (at most 155 characters) built from the same facts as the lede. */
export function supplierDescription(i: SupplierCopyInput): string {
  return fitDescription(
    [
      [supplierLede(i), supplierLede(i, 40), supplierLede(i, 24)],
      ' Each award links to its government record.',
    ],
    { max: MAX_SUPPLIER_DESCRIPTION }
  );
}

/** "City, ST" from the CAGE file; never anything more specific. */
export function supplierPlace(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = squash(city ?? '');
  const s = squash(state ?? '');
  if (c && s) return `${c}, ${s}`;
  return c || s || null;
}

/** JSON-LD text: markup characters are dropped so a name can never close the script element. */
export const schemaText = (v: string): string => v.replace(/[<>]/g, '');

// ---------------------------------------------------------------------------
// Supplier search (/api/suppliers.json)

export type SupplierQuery =
  | { kind: 'none' }
  | { kind: 'cage'; cage: string; /** also try the name when the exact CAGE finds nothing */ nameFallback: string | null }
  | { kind: 'name'; pattern: string };

/** Escapes LIKE wildcards so user text is matched literally. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Reads the `q` parameter. Under 3 characters (after trimming) is no query. A
 * value of exactly five characters A-Z0-9 is a CAGE code, matched exactly
 * (all-letter values also fall back to a name search when no CAGE matches);
 * anything else is a case-insensitive name search.
 */
export function parseSupplierQuery(raw: string): SupplierQuery {
  const q = squash(raw).slice(0, 80);
  if (q.length < 3) return { kind: 'none' };
  if (CAGE_RE.test(q)) return { kind: 'cage', cage: q, nameFallback: /\d/.test(q) ? null : `%${escapeLike(q)}%` };
  return { kind: 'name', pattern: `%${escapeLike(q)}%` };
}

// ---------------------------------------------------------------------------
// Solicitation countdown

export interface Countdown {
  text: string;
  cls: 'green' | 'amber' | '';
}

/**
 * Whole days from `today` (a UTC date) to an ISO return-by date; null when
 * there is no date. Computed per request, never at build time.
 */
export function daysUntilClose(returnBy: string | null, today: Date): number | null {
  if (!returnBy) return null;
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.ceil((new Date(`${returnBy}T00:00:00Z`).getTime() - todayMs) / 86400000);
}

/** "Closes in N days" badge text and tone for an open solicitation. */
export function countdownBadge(days: number | null): Countdown {
  if (days === null) return { text: 'Close date unknown', cls: '' };
  if (days <= 0) return { text: 'Closes today', cls: 'amber' };
  if (days <= 2) return { text: `Closes in ${days} day${days === 1 ? '' : 's'}`, cls: 'amber' };
  return { text: `Closes in ${days} days`, cls: 'green' };
}

/** Status badge for any solicitation status: open reads green, every closed status neutral. */
export function statusBadge(status: string): Countdown {
  if (status === 'open') return { text: 'Open', cls: 'green' };
  return { text: status.charAt(0).toUpperCase() + status.slice(1), cls: '' };
}
