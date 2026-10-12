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

export type ListKey = 'dollars-12m' | 'dollars-all' | 'wins-12m' | 'wins-all' | 'breadth-nsns' | 'breadth-fscs' | 'rising';

interface ListDef {
  key: ListKey;
  /** CSV "list" column value. */
  csv: string;
  rank: keyof BoardSupplier;
}

export const LISTS: ListDef[] = [
  { key: 'dollars-12m', csv: 'dollars_12m', rank: 'rankDollars12m' },
  { key: 'dollars-all', csv: 'dollars_all', rank: 'rankDollarsAll' },
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
] as const;

const cents = (n: number) => Math.round(n * 100) / 100;

/** One row per (list, supplier) for every ranked list; lists in LISTS order, each in rank order. */
export function leaderboardRows(data: BoardData): (string | number | null)[][] {
  const asOf = data.headline.asOf;
  const out: (string | number | null)[][] = [];
  for (const def of LISTS) {
    for (const s of listFor(data.suppliers, def.key)) {
      out.push([
        def.csv, s[def.rank] as number, s.cage, s.name, s.city, s.state, s.awards12m, cents(s.dollars12m), s.awardsPrior12m,
        cents(s.dollarsPrior12m), s.awardsAll, cents(s.dollarsAll), s.nsns, s.fscs, asOf,
      ]);
    }
  }
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
