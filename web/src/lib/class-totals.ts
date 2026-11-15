// class-totals.ts: the ONE place that decides what a supply class's purchase count and dollars are.
//
// The class page ("Purchase records", "Total $"), classes.csv, and the class share card all read it, so they cannot
// disagree. A class's figures are, per NSN, the price points and the NSN-attached contract actions, plus the class's
// category-level contract actions:
//   - a DIBBS award that is both a price point and a DIBBS contract action counts once (award-dedupe.ts, PR #14);
//   - a long-term contract's base award is not a purchase and adds no dollars (contract-ceiling.ts, PR #21);
//     price points that are ceilings never reach this module (the build query leaves them out), actions carry isCeiling;
//   - dollars of a price point: its total, else unit price x quantity (quantity 1 when unknown); of an action: its
//     obligation (null counts as 0).
//
// Imports are limited to award-dedupe.ts (with its extension) so node --test can load this file directly.

import { withoutDuplicatedPricePoints, type DedupeAction, type DedupePricePoint } from './award-dedupe.ts';

export interface TotalsPoint extends DedupePricePoint {
  unitPrice: number;
  quantity: number | null;
  totalValue: number | null;
}

export interface TotalsAction extends DedupeAction {
  obligation: number | null;
  isCeiling?: boolean;
}

/** Category-level contract actions of a class (lib/class-actions.ts summary): every row, how many are ceilings, dollars of the rest. */
export interface ClassLevelActions {
  count: number;
  ceilingCount: number;
  obligated: number;
}

export const pointDollars = (p: { unitPrice: number; quantity: number | null; totalValue: number | null }): number =>
  p.totalValue ?? p.unitPrice * (p.quantity ?? 1);

/** The records that count for one NSN, and their number and dollars. */
export function nsnRecords<P extends TotalsPoint, A extends TotalsAction>(points: readonly P[], actions: readonly A[], actionsFor: (nsn: string) => readonly DedupeAction[]) {
  const keptPoints = withoutDuplicatedPricePoints(points, actionsFor);
  const keptActions = actions.filter((a) => !a.isCeiling);
  return {
    points: keptPoints,
    actions: keptActions,
    records: keptPoints.length + keptActions.length,
    dollars: keptPoints.reduce((s, p) => s + pointDollars(p), 0) + keptActions.reduce((s, c) => s + (c.obligation ?? 0), 0),
  };
}

/** Purchase records and dollars of a whole class: its NSNs (in the given order) plus its category-level actions. */
export function classTotals<P extends TotalsPoint, A extends TotalsAction>(
  nsns: readonly string[],
  pointsFor: (nsn: string) => readonly P[],
  actionsFor: (nsn: string) => readonly A[],
  classLevel: ClassLevelActions | null | undefined
): { purchases: number; dollars: number } {
  let purchases = 0;
  let dollars = 0;
  for (const nsn of nsns) {
    const r = nsnRecords(pointsFor(nsn), actionsFor(nsn), actionsFor);
    purchases += r.records;
    dollars += r.dollars;
  }
  if (classLevel) {
    purchases += classLevel.count - classLevel.ceilingCount;
    dollars += classLevel.obligated;
  }
  return { purchases, dollars };
}

export interface CardStat {
  value: string;
  label: string;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * The three (or two) figures of a class's share card. A class with solicitations on record leads with its open
 * demand (counts equal /open/<fsc>/); one without shows its catalog counts (equal to the class page).
 */
export function classCardStats(i: {
  open: number;
  closing: number;
  onRecord: number;
  nsns: number;
  purchases: number;
}): CardStat[] {
  return i.onRecord > 0
    ? [
        { value: fmt(i.open), label: i.open === 1 ? 'open solicitation' : 'open solicitations' },
        { value: fmt(i.closing), label: 'closing within 7 days' },
        { value: fmt(i.onRecord), label: 'solicitations on record' },
      ]
    : [
        { value: fmt(i.nsns), label: 'stock numbers tracked' },
        { value: fmt(i.purchases), label: 'purchase records' },
      ];
}
