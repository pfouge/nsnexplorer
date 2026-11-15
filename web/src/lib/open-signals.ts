// open-signals.ts — pure helpers behind the /open/<class>/ signals: the
// tech-docs flag, the "Past due, no award found" status, and the estimated
// value. Dependency-free so the browser filter script can import it too.

export type TechDocsKind = 'none' | 'tech_docs' | 'spec_only';

/** Past-due window, in whole days since return_by (both ends inclusive). */
export const PAST_DUE_MIN_DAYS = 30;
export const PAST_DUE_MAX_DAYS = 180;

/** Normalizes DIBBS raw->>'techDocs' ('None', 'Tech Docs', 'Tech Docs *Spec/Stnd Only'). */
export function techDocsKind(raw: string | null | undefined): TechDocsKind | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === '') return null;
  if (t === 'none') return 'none';
  if (t.startsWith('tech docs')) return /spec\/?\s*stnd only/.test(t) ? 'spec_only' : 'tech_docs';
  return null;
}

const DAY_MS = 86400000;
const isoMs = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/** True when returnBy is 30..180 whole days before today (ISO dates, YYYY-MM-DD). */
export function inPastDueWindow(returnByIso: string, todayIso: string): boolean {
  const days = Math.floor((isoMs(todayIso) - isoMs(returnByIso)) / DAY_MS);
  return days >= PAST_DUE_MIN_DAYS && days <= PAST_DUE_MAX_DAYS;
}

/**
 * Expired, 30..180 days past return_by, inside our DIBBS award coverage, and
 * with no matching award found. Cancelled and open rows never qualify.
 */
export function isPastDueUnawarded(
  sol: { status: string; returnBy: string | null; awardFound: boolean },
  todayIso: string,
  coverageFromIso: string | null
): boolean {
  if (sol.status !== 'expired' || !sol.returnBy || !coverageFromIso) return false;
  if (sol.returnBy < coverageFromIso || sol.awardFound) return false;
  return inPastDueWindow(sol.returnBy, todayIso);
}

/** Unit price of the most recent award (by awardedOn); non-positive prices are ignored. */
export function lastUnitPrice(points: { awardedOn: string; unitPrice: number }[]): number | null {
  let best: { awardedOn: string; unitPrice: number } | null = null;
  for (const p of points) {
    if (!(p.unitPrice > 0)) continue;
    if (best === null || p.awardedOn > best.awardedOn) best = p;
  }
  return best ? best.unitPrice : null;
}

/** quantity × unit price, rounded to cents; null unless both are positive. */
export function estimatedValue(quantity: number | null, unitPrice: number | null): number | null {
  if (quantity === null || unitPrice === null || !(quantity > 0) || !(unitPrice > 0)) return null;
  return Math.round(quantity * unitPrice * 100) / 100;
}

/** A solicitation is a "repost" when it was issued this many days (or fewer) after an earlier one closed. */
export const REPOST_WINDOW_DAYS = 30;

/**
 * Repost read for one NSN's solicitations: true when an OPEN solicitation was issued (issuedOn, falling back
 * to returnBy) 0..30 days AFTER the returnBy of a different solicitation that is expired or cancelled.
 * `priorReturnBy` is the latest such earlier returnBy. Prior rows with no returnBy, or a returnBy after
 * `todayIso` (bad data), are ignored. ISO dates, YYYY-MM-DD.
 */
export function isRepost(
  sols: { solNumber: string; status: string; issuedOn: string | null; returnBy: string | null }[],
  todayIso: string
): { repost: boolean; priorReturnBy: string | null } {
  let prior: string | null = null;
  for (const open of sols) {
    if (open.status !== 'open') continue;
    const start = open.issuedOn ?? open.returnBy;
    if (!start) continue;
    for (const p of sols) {
      if (p.solNumber === open.solNumber || (p.status !== 'expired' && p.status !== 'cancelled')) continue;
      if (!p.returnBy || p.returnBy.slice(0, 10) > todayIso.slice(0, 10)) continue;
      const gap = Math.round((isoMs(start) - isoMs(p.returnBy)) / DAY_MS);
      if (gap >= 0 && gap <= REPOST_WINDOW_DAYS && (prior === null || p.returnBy > prior)) prior = p.returnBy;
    }
  }
  return { repost: prior !== null, priorReturnBy: prior };
}

export interface OpenTotals { parts: number; units: number; value: number; priced: number }

/** Sums the visible rows: `qty` is units, `estValue` is dollars with 0 meaning "no estimate". */
export function sumOpenTotals(rows: { qty: number; estValue: number }[]): OpenTotals {
  const t: OpenTotals = { parts: 0, units: 0, value: 0, priced: 0 };
  for (const r of rows) {
    t.parts++;
    if (r.qty > 0) t.units += r.qty;
    if (r.estValue > 0) { t.value += r.estValue; t.priced++; }
  }
  return t;
}

/** "N parts · Q units · ≈ $V at last price (M of N priced)"; `partial` appends " on this page". */
export function totalsLine(t: OpenTotals, partial = false): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const price = t.priced > 0 ? `≈ $${n(Math.round(t.value))} at last price` : 'no last price on record';
  return `${n(t.parts)} ${t.parts === 1 ? 'part' : 'parts'} · ${n(t.units)} ${t.units === 1 ? 'unit' : 'units'} · ${price} (${n(t.priced)} of ${n(t.parts)} priced)${partial ? ' on this page' : ''}`;
}
