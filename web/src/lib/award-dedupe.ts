// One DIBBS award can be on record twice for an NSN: as a pub.contract_actions row
// (every award-grid row, ingest/dibbs/load.mjs mapAwardToContractAction) and, when it
// matched a retained solicitation, as a pub.price_points row (mapAwardToPricePoint) with
// source 'dibbs_award'. Summing both lists counts that award twice.
//
// The shared key is the award reference. A price point's award_ref is
// awardNumber[-deliveryOrder]; the action's piid is awardNumber[/deliveryOrder] (its
// award_uid adds a PurchaseRequest suffix, so piid is the reliable side). Both rows carry
// the same normalised NSN, so the identity is nsn + award reference.

export interface DedupePricePoint {
  nsn: string;
  source: string;
  awardRef: string;
}

export interface DedupeAction {
  awardUid: string;
  piid: string | null;
}

export const DIBBS_AWARD_SOURCE = 'dibbs_award';

/** Award reference of a DIBBS contract action in price-point form, or null for non-DIBBS rows. */
export function dibbsActionRef(a: DedupeAction): string | null {
  if (!a.awardUid.startsWith('DIBBS-')) return null;
  const piid = a.piid?.trim();
  return piid ? piid.replace('/', '-') : null;
}

/**
 * The price points to keep: everything except dibbs_award price points whose award is
 * already present as a DIBBS contract action for the same NSN. Actions are never dropped
 * (they cover every award; price points only the matched ones).
 */
export function withoutDuplicatedPricePoints<P extends DedupePricePoint>(
  points: readonly P[],
  actionsByNsn: (nsn: string) => readonly DedupeAction[]
): P[] {
  const refs = new Map<string, Set<string>>();
  const refsFor = (nsn: string): Set<string> => {
    let s = refs.get(nsn);
    if (!s) {
      s = new Set<string>();
      for (const a of actionsByNsn(nsn)) {
        const r = dibbsActionRef(a);
        if (r) s.add(r);
      }
      refs.set(nsn, s);
    }
    return s;
  };
  return points.filter((p) => !(p.source === DIBBS_AWARD_SOURCE && refsFor(p.nsn).has(p.awardRef)));
}
