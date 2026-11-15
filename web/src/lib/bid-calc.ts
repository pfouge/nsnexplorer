// Pure arithmetic for the bid calculator on solicitation and NSN pages. No imports, no I/O.
// It reports arithmetic on the visitor's own numbers and public award prices; it never recommends a price.

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface QuoteInput {
  unitCost: number | null;
  /** Margin as a percentage of the selling price: (price - cost) / price. */
  marginPct: number | null;
  unitPrice: number | null;
  quantity: number | null;
  /** Freight, packaging, testing: one amount for the whole order, spread over quantity. */
  otherCostPerOrder?: number | null;
}

export interface QuoteResult {
  unitPrice: number | null;
  /** Unit margin on the selling price; other cost per order is not part of it. */
  marginPct: number | null;
  /** Price - cost - other cost per order / quantity. */
  profitPerUnit: number | null;
  total: number | null;
  profitTotal: number | null;
}

/**
 * Solves whichever of unitPrice / marginPct was not given. If both are given, unitPrice is used and the margin
 * is recomputed from it. A negative margin is allowed (price below cost); margin >= 100 has no price and gives null.
 */
export function quote(input: QuoteInput): QuoteResult {
  const none: QuoteResult = { unitPrice: null, marginPct: null, profitPerUnit: null, total: null, profitTotal: null };
  const { unitCost, marginPct, unitPrice, quantity } = input;
  if (!ok(unitCost) || unitCost <= 0) return none;

  let price: number | null = null;
  let margin: number | null = null;
  if (unitPrice !== null && unitPrice !== undefined) {
    if (!ok(unitPrice) || unitPrice <= 0) return none;
    price = unitPrice;
    margin = ((price - unitCost) / price) * 100;
  } else if (marginPct !== null && marginPct !== undefined) {
    if (!ok(marginPct) || marginPct >= 100) return none;
    price = unitCost / (1 - marginPct / 100);
    margin = marginPct;
  } else {
    return none;
  }

  const qty = ok(quantity) && quantity > 0 ? quantity : null;
  const other = input.otherCostPerOrder ?? 0;
  const otherValid = ok(other) && other >= 0;
  let profitPerUnit: number | null = null;
  if (otherValid) {
    if (other === 0) profitPerUnit = price - unitCost;
    else if (qty !== null) profitPerUnit = price - unitCost - other / qty;
  }
  const total = qty !== null ? price * qty : null;
  const profitTotal = profitPerUnit !== null && qty !== null ? profitPerUnit * qty : null;
  return { unitPrice: price, marginPct: margin, profitPerUnit, total, profitTotal };
}

export interface PriceRef {
  latest: number;
  low: number;
  high: number;
  average: number;
}
export interface Comparison {
  vsLatestPct: number | null;
  vsAveragePct: number | null;
  position: 'below_range' | 'in_range' | 'above_range' | null;
}

const pctDiff = (price: number, ref: number): number | null => (ok(ref) && ref > 0 ? round1(((price - ref) / ref) * 100) : null);

/** Percent difference from the last award and from the five-award average (one decimal), and where the price sits against low..high (ends count as in range). */
export function compare(unitPrice: number | null, summary: PriceRef | null): Comparison {
  const none: Comparison = { vsLatestPct: null, vsAveragePct: null, position: null };
  if (!ok(unitPrice) || unitPrice <= 0 || !summary) return none;
  const position = ok(summary.low) && ok(summary.high) ? (unitPrice < summary.low ? 'below_range' : unitPrice > summary.high ? 'above_range' : 'in_range') : null;
  return { vsLatestPct: pctDiff(unitPrice, summary.latest), vsAveragePct: pctDiff(unitPrice, summary.average), position };
}

function ymd(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return [y, mo, d];
}

/** Whole calendar months from one ISO date to another (a part month does not count); null for a bad date or an end before the start. */
export function wholeMonths(fromIso: string, toIso: string): number | null {
  const a = ymd(fromIso);
  const b = ymd(toIso);
  if (!a || !b) return null;
  const months = (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
  return months < 0 ? null : months;
}

/**
 * The last award price carried forward by the annual rate over the whole months since the award.
 * Compounded monthly at the rate that makes twelve months equal one full year's rate: price * (1 + r)^(months / 12).
 */
export function adjustForTime(lastPrice: number, lastAwardIso: string, todayIso: string, annualRatePct: number): number | null {
  if (!ok(lastPrice) || lastPrice <= 0 || !ok(annualRatePct) || annualRatePct <= -100) return null;
  const months = wholeMonths(lastAwardIso, todayIso);
  if (months === null) return null;
  return lastPrice * Math.pow(1 + annualRatePct / 100, months / 12);
}

/** Accepts "$", commas and spaces around digits and one decimal point. Null unless a positive number. */
export function parseMoney(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/[\s$,]/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A percentage field: optional "%" and sign, zero allowed. Null when empty or not a number. */
export function parsePercent(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/[\s,%]/g, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
