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
