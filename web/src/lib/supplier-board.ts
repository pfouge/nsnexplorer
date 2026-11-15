// Pure model for the /supplier/ leaderboard: the shapes the build-time loader
// (supplier-board-data.ts) fills from pub.supplier_stats, the lists derived
// from the precomputed ranks, the "small business" rule, and the CSV rows.
// No I/O and no pg, so it runs under `node --test`.
//
// Ranks are computed in SQL by pub.refresh_supplier_stats() (award value =
// recorded total, else unit price x quantity; ties broken by CAGE). This
// module only reads them: a list is "the suppliers whose rank for that metric
// is 1..BOARD_SIZE, in rank order".

import { BOARD_SIZE } from './supplier-view.ts';

export { BOARD_SIZE };

export interface BoardSupplier {
  cage: string;
  name: string | null;
  city: string | null;
  state: string | null;
  awardsAll: number;
  dollarsAll: number;
  awards12m: number;
  dollars12m: number;
  awardsPrior12m: number;
  dollarsPrior12m: number;
  nsns: number;
  fscs: number;
  risingDelta: number | null;
  rankDollars12m: number | null;
  rankDollarsAll: number | null;
  rankWins12m: number | null;
  rankWinsAll: number | null;
  rankNsns: number | null;
  rankFscs: number | null;
  rankRising: number | null;
  /** Last 90 days (awarded_on > today - 90). Purchases only: long-term contract base awards never count. */
  awards90d: number;
  dollars90d: number;
  rankDollars90d: number | null;
  rankWins90d: number | null;
  /** 12-month dollar rank as of 30 days ago (365 days ending 30 days ago); null when there were no dollars then. */
  rankDollars12mPrev: number | null;
  /** Long-term contract base awards (contract ceilings): counted here, never in awards or dollars. */
  longTermContracts: number;
}

export interface BoardHeadline {
  /** Suppliers with at least one indexed award (rows in supplier_stats). */
  suppliers: number;
  awards12m: number;
  dollars12m: number;
  /** Suppliers whose SAM record says small business (see isSmallBusiness). */
  small: number;
  /** Suppliers with a SAM.gov record loaded; the small-business count means nothing while this is 0. */
  withSam: number;
  /** Distinct US state / territory codes among those suppliers' CAGE locations. */
  states: number;
  /** supplier_stats.refreshed_at, ISO date, or null when the table is empty. */
  asOf: string | null;
  /** First day (ISO) from which DIBBS award rows are dense (same rule as SiteData.awardCoverageFrom), or null. */
  coverageFrom: string | null;
  /** Suppliers whose only awards are long-term contracts (no orders yet), all of them, not just the listed ones. */
  longTermOnly: number;
}

export interface StateRow {
  state: string;
  suppliers: number;
  dollars12m: number;
}

export interface BoardData {
  headline: BoardHeadline;
  /** Union of every supplier that is on at least one list. */
  suppliers: BoardSupplier[];
  states: StateRow[];
}

export type ListKey =
  | 'dollars-90d' | 'dollars-12m' | 'dollars-all' | 'wins-90d' | 'wins-12m' | 'wins-all' | 'breadth-nsns' | 'breadth-fscs' | 'rising';

interface ListDef {
  key: ListKey;
  /** CSV "list" column value. */
  csv: string;
  rank: keyof BoardSupplier;
}

export const LISTS: ListDef[] = [
  { key: 'dollars-90d', csv: 'dollars_90d', rank: 'rankDollars90d' },
  { key: 'dollars-12m', csv: 'dollars_12m', rank: 'rankDollars12m' },
  { key: 'dollars-all', csv: 'dollars_all', rank: 'rankDollarsAll' },
  { key: 'wins-90d', csv: 'wins_90d', rank: 'rankWins90d' },
  { key: 'wins-12m', csv: 'wins_12m', rank: 'rankWins12m' },
  { key: 'wins-all', csv: 'wins_all', rank: 'rankWinsAll' },
  { key: 'breadth-nsns', csv: 'nsns', rank: 'rankNsns' },
  { key: 'breadth-fscs', csv: 'supply_classes', rank: 'rankFscs' },
  { key: 'rising', csv: 'rising', rank: 'rankRising' },
];

/** The suppliers on one list, rank 1 first, at most `size` of them. */
export function listFor(suppliers: BoardSupplier[], key: ListKey, size = BOARD_SIZE): BoardSupplier[] {
  const def = LISTS.find((l) => l.key === key);
  if (!def) return [];
  return suppliers
    .filter((s) => {
      const r = s[def.rank];
      return typeof r === 'number' && r >= 1 && r <= size;
    })
    .sort((a, b) => (a[def.rank] as number) - (b[def.rank] as number) || a.cage.localeCompare(b.cage));
}

/** True for a supplier whose only awards are long-term contracts: no orders yet, no dollars, no rank. */
export function isLongTermOnly(s: Pick<BoardSupplier, 'awardsAll' | 'longTermContracts'>): boolean {
  return s.awardsAll === 0 && s.longTermContracts > 0;
}

/**
 * The suppliers with long-term contracts and no orders yet, most contracts first, ties by CAGE (code-point
 * order). They sit below every dollar list and never take a rank.
 */
export function longTermOnlyList(suppliers: BoardSupplier[], size = BOARD_SIZE): BoardSupplier[] {
  return suppliers
    .filter(isLongTermOnly)
    .sort((a, b) => b.longTermContracts - a.longTermContracts || (a.cage < b.cage ? -1 : a.cage > b.cage ? 1 : 0))
    .slice(0, size);
}

/** "1 long-term contract, no orders yet" / "3 long-term contracts, no orders yet". */
export function longTermText(n: number): string {
  return `${n.toLocaleString('en-US')} long-term contract${n === 1 ? '' : 's'}, no orders yet`;
}

// ---------------------------------------------------------------------------
// Rank trend (12-month dollar rank now against about 30 days ago)

export interface RankTrend {
  kind: 'up' | 'down' | 'same' | 'new';
  /** Places moved (0 for same and new). */
  places: number;
  /** Visible, compact: an arrow and a number ("▲ 3"), "=" for no change, "new". */
  glyph: string;
  /** Plain words for screen readers and tooltips. */
  text: string;
}

/**
 * Movement of a 12-month dollar rank: `now` is today's rank, `before` the rank for the 365 days ending 30 days ago
 * (null when the supplier had no dollars then). A smaller number is a better rank, so a drop in the number is "up".
 * Null when the supplier has no rank today.
 */
export function rankTrend(now: number | null, before: number | null): RankTrend | null {
  if (typeof now !== 'number') return null;
  if (typeof before !== 'number') return { kind: 'new', places: 0, glyph: 'new', text: 'New: no award dollars 30 days ago' };
  const places = Math.abs(before - now);
  const noun = places === 1 ? 'place' : 'places';
  if (before > now) return { kind: 'up', places, glyph: `\u25B2 ${places}`, text: `Up ${places} ${noun} since 30 days ago` };
  if (before < now) return { kind: 'down', places, glyph: `\u25BC ${places}`, text: `Down ${places} ${noun} since 30 days ago` };
  return { kind: 'same', places: 0, glyph: '=', text: 'No change since 30 days ago' };
}

/** One sentence about "All time" for the leaderboard: its start date is when DIBBS award rows become dense. */
export function allTimeNote(coverageLabel: string | null): string {
  return coverageLabel
    ? `All time means since ${coverageLabel}: our DIBBS award records are dense only from that date.`
    : 'All time means every award we have indexed so far, which is not everything a supplier has won.';
}

// ---------------------------------------------------------------------------
// Small business

/**
 * A SAM business-type label that means small business: it contains the word
 * "small" ("Small Business", "Woman Owned Small Business", "Small
 * Disadvantaged Business", ...) but is not the negation ("Other than Small
 * Business"). The SQL in supplier-board-data.ts applies the same two tests.
 */
export function isSmallLabel(label: string): boolean {
  return /\bsmall\b/i.test(label) && !/^\s*other than\b/i.test(label);
}

/** Small business by this site's definition: any NAICS flagged small, or any small-business label. */
export function isSmallBusiness(businessTypes: string[], naics: { small?: boolean | null }[]): boolean {
  return naics.some((n) => n.small === true) || businessTypes.some(isSmallLabel);
}

export const SMALL_FOOTNOTE =
  'Small business here means the supplier\'s SAM.gov registration flags at least one of its NAICS codes as small, or lists a small-business type (for example Small Business or Woman Owned Small Business, but not "Other than Small Business"). Suppliers with no SAM record are not counted.';

// ---------------------------------------------------------------------------
// CSV

export const leaderboardHeaders = [
  'list', 'rank', 'cage', 'supplier', 'city', 'state', 'awards_12m', 'dollars_12m', 'awards_prior_12m', 'dollars_prior_12m',
  'awards_all', 'dollars_all', 'nsns', 'supply_classes', 'as_of',
  // Added after as_of so existing column positions did not move.
  'awards_90d', 'dollars_90d', 'long_term_contracts', 'rank_dollars_12m_30_days_ago',
] as const;

const cents = (n: number) => Math.round(n * 100) / 100;

function csvRow(list: string, rank: number | null, s: BoardSupplier, asOf: string | null): (string | number | null)[] {
  return [
    list, rank, s.cage, s.name, s.city, s.state, s.awards12m, cents(s.dollars12m), s.awardsPrior12m,
    cents(s.dollarsPrior12m), s.awardsAll, cents(s.dollarsAll), s.nsns, s.fscs, asOf,
    s.awards90d, cents(s.dollars90d), s.longTermContracts, s.rankDollars12mPrev,
  ];
}

/** One row per (list, supplier) for every ranked list; lists in LISTS order, each in rank order. */
export function leaderboardRows(data: BoardData): (string | number | null)[][] {
  const asOf = data.headline.asOf;
  const out: (string | number | null)[][] = [];
  for (const def of LISTS) {
    for (const s of listFor(data.suppliers, def.key)) {
      out.push(csvRow(def.csv, s[def.rank] as number, s, asOf));
    }
  }
  // Last, unranked: suppliers with long-term contracts and no orders yet (rank column empty).
  for (const s of longTermOnlyList(data.suppliers)) out.push(csvRow('long_term_only', null, s, asOf));
  return out;
}

// ---------------------------------------------------------------------------
// Copy

const int = (n: number) => n.toLocaleString('en-US');

/** "$12.3M" / "$480K" / "$950" for headline tiles. */
export function compactUsd(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}K`;
  return `${s}$${int(Math.round(a))}`;
}

/** Signed dollar change for the Rising list: "+$1.2M" / "-$800". */
export function signedUsd(v: number): string {
  const c = compactUsd(Math.abs(v));
  return v > 0 ? `+${c}` : v < 0 ? `-${c}` : c;
}

// ---------------------------------------------------------------------------
// Page copy (title + suffix <= 70, description 140-160 characters)

export const BOARD_TITLE = 'Top Government Parts Suppliers: Awards Leaderboard';
export const BOARD_H1 = 'Top government parts suppliers: awards leaderboard';

/** Meta description for /supplier/; the count is dropped when no supplier is ranked yet. */
export function boardDescription(suppliers: number): string {
  return suppliers > 0
    ? `Leaderboard of ${int(suppliers)} government parts suppliers ranked by award dollars, wins, range of items and rising sales, from DIBBS and USAspending records.`
    : 'Leaderboard of government parts suppliers ranked by award dollars, wins, range of items and rising sales, built from public DIBBS and USAspending award records.';
}
