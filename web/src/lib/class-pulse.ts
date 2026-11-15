// "Right now" numbers for a supply class page: open bids, recent awards and
// distinct winners. Pure date arithmetic and aggregation; the page maps its
// SiteData records into the small shapes below so this stays testable.

export interface PulseSolicitation {
  returnBy: string | null; // ISO date (YYYY-MM-DD)
}

export interface PulseAward {
  date: string | null; // ISO date
  amount: number;
  /** Stable winner identity (CAGE, UEI or normalised name); null when unknown. */
  supplierKey: string | null;
}

export interface ClassPulse {
  open: { count: number; closingSoon: number };
  /** null when the class has no dated award records at all. */
  awarded90: { count: number; dollars: number } | null;
  /** null when no winner is identifiable in the window. */
  suppliers12: { count: number } | null;
}

export const CLOSING_WINDOW_DAYS = 7;
export const AWARD_WINDOW_DAYS = 90;
export const SUPPLIER_WINDOW_DAYS = 365;

const DAY_MS = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to` (both ISO dates); null if either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  if (!ISO.test(from) || !ISO.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/** Identity for a winner: the CAGE or UEI when there is one, else the trimmed lower-case name. */
export function supplierKey(id: string | null | undefined, name: string | null | undefined): string | null {
  const i = id?.trim().toUpperCase();
  if (i) return `id:${i}`;
  const n = name?.trim().toLowerCase().replace(/\s+/g, ' ');
  return n ? `name:${n}` : null;
}

/** True when `date` falls in the `days` days up to and including `today` (never the future). */
function withinLast(date: string | null, today: string, days: number): boolean {
  if (!date) return false;
  const d = daysBetween(date, today);
  return d !== null && d >= 0 && d < days;
}

export function buildClassPulse(
  today: string,
  solicitations: readonly PulseSolicitation[],
  awards: readonly PulseAward[]
): ClassPulse {
  let closingSoon = 0;
  for (const s of solicitations) {
    if (!s.returnBy) continue;
    const d = daysBetween(today, s.returnBy);
    if (d !== null && d >= 0 && d <= CLOSING_WINDOW_DAYS) closingSoon += 1;
  }

  const dated = awards.filter((a) => a.date && daysBetween(a.date, today) !== null);
  let count = 0;
  let dollars = 0;
  const winners = new Set<string>();
  for (const a of dated) {
    if (withinLast(a.date, today, AWARD_WINDOW_DAYS)) {
      count += 1;
      dollars += Number.isFinite(a.amount) ? a.amount : 0;
    }
    if (a.supplierKey && withinLast(a.date, today, SUPPLIER_WINDOW_DAYS)) winners.add(a.supplierKey);
  }

  return {
    open: { count: solicitations.length, closingSoon },
    awarded90: dated.length > 0 ? { count, dollars } : null,
    suppliers12: winners.size > 0 ? { count: winners.size } : null,
  };
}
