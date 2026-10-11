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
  { key: 'rankDollars12m', what: 'by award dollars, last 12 months', href: '/supplier/#dollars-12m' },
  { key: 'rankDollarsAll', what: 'by award dollars, all time', href: '/supplier/#dollars-all' },
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
    rankDollars12m: 'Award dollars, last 12 months',
    rankDollarsAll: 'Award dollars, all time',
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
