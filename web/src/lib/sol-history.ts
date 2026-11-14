// Pure helpers for the price-history blocks on /solicitation/<number>/.
// No imports, no I/O: the page feeds in the loader's partPrices.

export interface HistoryPoint {
  awardedOn: string;
  unitPrice: number;
  quantity?: number | null;
  cage: string | null;
  supplierName: string | null;
}

export interface PriceSummary {
  n: number;
  latest: number;
  low: number;
  high: number;
  average: number;
}

export interface WinnerRow {
  cage: string;
  supplierName: string | null;
  wins: number;
  lastWon: string;
  lastPrice: number;
}

export interface RepeatWinner {
  cage: string;
  supplierName: string | null;
  streak: number;
}

const SUMMARY_WINDOW = 5;
const MIN_STREAK = 3;

const cageOf = (p: HistoryPoint): string | null => {
  const c = (p.cage ?? '').trim();
  return c === '' ? null : c;
};

/** Newest first; a stable sort keeps the input order (the loader's id order) for ties. */
const newestFirst = <T extends HistoryPoint>(points: readonly T[]): T[] =>
  [...points].sort((a, b) => (a.awardedOn < b.awardedOn ? 1 : a.awardedOn > b.awardedOn ? -1 : 0));

const cents = (n: number): number => Math.round(n * 100) / 100;

/** Low / high / average over the most recent five points with a positive unit price. */
export function priceSummary(points: readonly HistoryPoint[]): PriceSummary | null {
  const recent = newestFirst(points)
    .filter((p) => Number.isFinite(p.unitPrice) && p.unitPrice > 0)
    .slice(0, SUMMARY_WINDOW);
  if (recent.length === 0) return null;
  const prices = recent.map((p) => p.unitPrice);
  return {
    n: recent.length,
    latest: prices[0],
    low: Math.min(...prices),
    high: Math.max(...prices),
    average: cents(prices.reduce((a, b) => a + b, 0) / prices.length),
  };
}

/** Wins per CAGE (points without a CAGE are ignored), most wins first, then most recent win. */
export function winners(points: readonly HistoryPoint[]): WinnerRow[] {
  const byCage = new Map<string, WinnerRow>();
  for (const p of newestFirst(points)) {
    const cage = cageOf(p);
    if (!cage) continue;
    const row = byCage.get(cage);
    if (row) {
      row.wins += 1;
      if (row.supplierName === null && p.supplierName) row.supplierName = p.supplierName;
    } else {
      byCage.set(cage, { cage, supplierName: p.supplierName ?? null, wins: 1, lastWon: p.awardedOn, lastPrice: p.unitPrice });
    }
  }
  return [...byCage.values()].sort((a, b) => b.wins - a.wins || (a.lastWon < b.lastWon ? 1 : a.lastWon > b.lastWon ? -1 : 0));
}

/** The same CAGE on the most recent 3+ consecutive points that have a CAGE. */
export function repeatWinner(points: readonly HistoryPoint[]): RepeatWinner | null {
  const withCage = newestFirst(points).filter((p) => cageOf(p) !== null);
  if (withCage.length < MIN_STREAK) return null;
  const cage = cageOf(withCage[0])!;
  let streak = 0;
  while (streak < withCage.length && cageOf(withCage[streak]) === cage) streak += 1;
  if (streak < MIN_STREAK) return null;
  const named = withCage.slice(0, streak).find((p) => p.supplierName);
  return { cage, supplierName: named?.supplierName ?? null, streak };
}

/** Quantity x last unit price, rounded to cents; null unless both are positive. */
export function valueAtLastPrice(quantity: number | null | undefined, latest: number | null | undefined): number | null {
  if (typeof quantity !== 'number' || typeof latest !== 'number') return null;
  if (!(quantity > 0) || !(latest > 0) || !Number.isFinite(quantity) || !Number.isFinite(latest)) return null;
  return cents(quantity * latest);
}
