// Pure presentation helpers for /supplier/<CAGE>/ (no I/O, no pg): address
// formatting, rank badges, the SAM.gov entity link, registration status, the
// 12-month vs prior-12-month comparison, the About-section provenance line
// and the page's meta copy. Runs in the Workers runtime, at build time and
// under `node --test`.

import type { SupplierAddress, SupplierSam, SupplierStats, SupplierWeb } from './supplier-page.ts';

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Display lines for an address: street lines, "City, ST ZIP-1234", and the country when it is not the USA. */
export function addressLines(a: SupplierAddress | null): string[] {
  if (!a) return [];
  const lines: string[] = [];
  if (a.line1) lines.push(a.line1);
  if (a.line2) lines.push(a.line2);
  const zip = a.zip ? (a.zip4 ? `${a.zip}-${a.zip4}` : a.zip) : null;
  const region = [a.state, zip].filter(Boolean).join(' ');
  const cityLine = [a.city, region || null].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  const c = (a.country ?? '').toUpperCase();
  if (c && c !== 'USA' && c !== 'US' && c !== 'UNITED STATES') lines.push(a.country as string);
  return lines;
}

const norm = (s: string | null): string => squash(s ?? '').toUpperCase().replace(/[.,]/g, '');

/** True when two addresses read the same (ignoring case, punctuation and the ZIP+4). */
export function sameAddress(a: SupplierAddress | null, b: SupplierAddress | null): boolean {
  if (!a || !b) return false;
  const key = (x: SupplierAddress) => [x.line1, x.line2, x.city, x.state, x.zip].map(norm).join('|');
  return key(a) === key(b);
}

/** SAM.gov entity search for a UEI (the /entity/<UEI>/coreData page 404s for some public records; the search always resolves), or null when there is no (valid) UEI. */
export function samEntityUrl(uei: string | null | undefined): string | null {
  const u = (uei ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{12}$/.test(u) ? `https://sam.gov/search/?index=ei&sfm%5BsimpleSearch%5D%5BkeywordRadio%5D=ALL&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bkey%5D=${u}&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bvalue%5D=${u}` : null;
}

/** "acmefasteners.example" from a URL (leading www. dropped), or null. */
export function siteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

/** tel: href from a display phone number; null when fewer than 7 digits. */
export function telHref(phone: string | null | undefined): string | null {
  const raw = (phone ?? '').trim();
  const ext = raw.match(/(?:ext\.?|x)\s*(\d{1,6})\s*$/i);
  const digits = raw.replace(/(?:ext\.?|x)\s*\d{1,6}\s*$/i, '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const num = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return `tel:${num}${ext ? `;ext=${ext[1]}` : ''}`;
}

/** mailto: href only for a plain address (the value came from a crawl). */
export function mailHref(email: string | null | undefined): string | null {
  const e = (email ?? '').trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(e) ? `mailto:${e}` : null;
}

export type RegistrationTone = 'green' | 'amber' | '';
export interface RegistrationBadge {
  text: string;
  tone: RegistrationTone;
}

/**
 * SAM registration badge. "Active" counts only while the expiration date has
 * not passed; an Active record past its expiry reads "Expired".
 */
export function registrationBadge(sam: SupplierSam | null, today: string): RegistrationBadge | null {
  if (!sam || !sam.registrationStatus) return null;
  const status = sam.registrationStatus;
  const exp = sam.expirationDate;
  const lapsed = exp !== null && exp < today;
  if (/^active$/i.test(status) && !lapsed) return { text: exp ? `SAM active until ${exp}` : 'SAM active', tone: 'green' };
  if (lapsed) return { text: `SAM registration expired ${exp}`, tone: 'amber' };
  return { text: `SAM ${status.toLowerCase()}`, tone: 'amber' };
}

// ---------------------------------------------------------------------------
// Ranks

export interface RankBadge {
  text: string;
  /** Anchor on /supplier/ of the list that ranks it. */
  href: string;
  rank: number;
}

/** Leaderboards list the top 100 only; badges link there so they appear only for ranks that are listed. */
export const BOARD_SIZE = 100;

const RANK_DEFS: { key: keyof SupplierStats; what: string; href: string }[] = [
  { key: 'rankDollars90d', what: 'by award dollars, last 90 days', href: '/supplier/#dollars-90d' },
  { key: 'rankDollars12m', what: 'by award dollars, last 12 months', href: '/supplier/#dollars-12m' },
  { key: 'rankDollarsAll', what: 'by award dollars, all time', href: '/supplier/#dollars-all' },
  { key: 'rankWins90d', what: 'by awards won, last 90 days', href: '/supplier/#wins-90d' },
  { key: 'rankWins12m', what: 'by awards won, last 12 months', href: '/supplier/#wins-12m' },
  { key: 'rankWinsAll', what: 'by awards won, all time', href: '/supplier/#wins-all' },
  { key: 'rankNsns', what: 'by distinct NSNs supplied', href: '/supplier/#breadth-nsns' },
  { key: 'rankFscs', what: 'by distinct supply classes', href: '/supplier/#breadth-fscs' },
  { key: 'rankRising', what: 'among rising suppliers', href: '/supplier/#rising' },
];

/** Rank badges for the ranks that fall on a leaderboard list, best rank first (ties keep list order). */
export function rankBadges(stats: SupplierStats | null, max = BOARD_SIZE): RankBadge[] {
  if (!stats) return [];
  const out: RankBadge[] = [];
  for (const d of RANK_DEFS) {
    const r = stats[d.key];
    if (typeof r === 'number' && r >= 1 && r <= max) out.push({ rank: r, text: `#${r} ${d.what}`, href: d.href });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** Every non-null rank with a plain label, for the Performance section. */
export function allRanks(stats: SupplierStats | null): { label: string; rank: number }[] {
  if (!stats) return [];
  const labels: Record<string, string> = {
    rankDollars90d: 'Award dollars, last 90 days',
    rankDollars12m: 'Award dollars, last 12 months',
    rankDollarsAll: 'Award dollars, all time',
    rankWins90d: 'Awards won, last 90 days',
    rankWins12m: 'Awards won, last 12 months',
    rankWinsAll: 'Awards won, all time',
    rankNsns: 'Distinct NSNs',
    rankFscs: 'Distinct supply classes',
    rankRising: 'Rising (12 months vs prior 12 months)',
  };
  return Object.entries(labels).flatMap(([k, label]) => {
    const r = (stats as unknown as Record<string, number | null>)[k];
    return typeof r === 'number' ? [{ label, rank: r }] : [];
  });
}

/** One plain sentence comparing award dollars in the last 12 months with the 12 before; null when both are zero. */
export function changeSentence(current: number, prior: number): string | null {
  if (!(current > 0) && !(prior > 0)) return null;
  if (!(prior > 0)) return 'Award dollars in the last 12 months compare with none recorded in the 12 months before.';
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct === 0) return 'Award dollars in the last 12 months were about the same as in the 12 months before.';
  return `Award dollars ${pct > 0 ? 'rose' : 'fell'} ${Math.abs(pct).toLocaleString('en-US')}% against the 12 months before.`;
}

// ---------------------------------------------------------------------------
// About / provenance

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '2026-09-21T...' -> 'September 21, 2026' (UTC). */
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export type AboutMode = 'summary' | 'meta' | 'none';

/**
 * What the About section may show: the AI summary when the crawl produced one,
 * the site's own meta description (quoted, labelled as theirs) for ok_no_ai,
 * otherwise nothing. Opted-out suppliers arrive with web = null.
 */
export function aboutMode(web: SupplierWeb | null): AboutMode {
  if (!web) return 'none';
  if (web.status === 'ok' && web.summary) return 'summary';
  if ((web.status === 'ok' || web.status === 'ok_no_ai') && web.metaDescription) return 'meta';
  return 'none';
}

/** True when the About section has anything besides the summary (chips, founded). */
export const aboutHasFacts = (web: SupplierWeb | null): boolean =>
  !!web && web.status === 'ok' && (web.products.length > 0 || web.capabilities.length > 0 || web.certifications.length > 0 || web.founded !== null);

/** Chip text for a supply class in the listed-parts breakdown: "5340 Hardware, Commercial · 42" (name omitted when unknown). */
export function partClassLabel(c: { fsc: string; name: string | null; count: number }): string {
  return `${c.fsc}${c.name ? ` ${c.name}` : ''} · ${c.count.toLocaleString('en-US')}`;
}

/** "+N more classes" text when the breakdown shows fewer classes than the supplier has; null when everything is shown. */
export function moreClassesText(classTotal: number, shown: number): string | null {
  const rest = classTotal - shown;
  return rest > 0 ? `+${rest.toLocaleString('en-US')} more ${rest === 1 ? 'class' : 'classes'}` : null;
}

/** Distinct classes among loaded part rows, in code order; the filter select is only offered when there are 2 or more. */
export function loadedClasses(rows: readonly { fsc: string }[]): string[] {
  return [...new Set(rows.map((r) => r.fsc))].sort();
}

/** "Showing X of Y loaded" for the class filter; fsc '' or 'all' means no filter. */
export function partFilterStatus(rows: readonly { fsc: string }[], fsc: string): { shown: number; text: string } {
  const shown = fsc === '' || fsc === 'all' ? rows.length : rows.filter((r) => r.fsc === fsc).length;
  return { shown, text: `Showing ${shown.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} loaded` };
}

// ---------------------------------------------------------------------------
// Rank trend, long-term contracts and the listed-parts pager

/** One plain sentence on how the 12-month dollar rank moved against about 30 days ago; null when there is no rank. */
export function rankTrendSentence(stats: SupplierStats | null): string | null {
  if (!stats || typeof stats.rankDollars12m !== 'number') return null;
  const now = stats.rankDollars12m;
  const before = stats.rankDollars12mPrev;
  if (typeof before !== 'number') return 'New in the 12-month dollar ranking: this supplier had no award dollars in the 12 months ending 30 days ago.';
  const places = Math.abs(before - now);
  const noun = places === 1 ? 'place' : 'places';
  if (before > now) return `Up ${places} ${noun} in the 12-month dollar ranking since about 30 days ago.`;
  if (before < now) return `Down ${places} ${noun} in the 12-month dollar ranking since about 30 days ago.`;
  return 'No change in the 12-month dollar ranking since about 30 days ago.';
}

/** Row range of one page of listed parts: "from" and "to" are 1-based and inclusive; both 0 when nothing matches. */
export function partsRange(matching: number, page: number, pageSize: number, shown: number): { from: number; to: number; pages: number } {
  if (matching <= 0 || shown <= 0) return { from: 0, to: 0, pages: Math.max(1, Math.ceil(matching / pageSize)) };
  const from = (page - 1) * pageSize + 1;
  return { from, to: from + shown - 1, pages: Math.ceil(matching / pageSize) };
}

/** "Showing 1 to 50 of 6,422 listed parts" or "... of 3,100 listed parts in class 5340". */
export function partsStatusText(r: { from: number; to: number }, matching: number, fsc: string | null): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const tail = `${matching === 1 ? 'listed part' : 'listed parts'}${fsc ? ` in class ${fsc}` : ''}`;
  if (matching <= 0) return `No ${fsc ? `listed parts in class ${fsc}` : 'listed parts'}`;
  if (r.from <= 0) return `This page is past the end of the ${n(matching)} ${tail}`;
  return `Showing ${n(r.from)} to ${n(r.to)} of ${n(matching)} ${tail}`;
}

/** URL of a page of the supplier's listed parts. Page 1 and "all classes" leave the query off; the fragment opens the parts list. */
export function partsHref(cage: string, fsc: string | null, page: number): string {
  const q: string[] = [];
  if (fsc) q.push(`class=${fsc}`);
  if (page > 1) q.push(`pp=${page}`);
  return `/supplier/${cage}/${q.length ? `?${q.join('&')}` : ''}#sp-parts`;
}
