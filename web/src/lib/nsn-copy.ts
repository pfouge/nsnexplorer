// Copy inputs for one NSN, computed the same way for the HTML page and its
// Markdown twin so the title, description and summary can never drift apart.
// Type-only import from nsn-page (which pulls in the postgres driver).
import type { NsnPageData } from './nsn-page';
import { parseCharacteristics, toDashedNsn } from './shared';
import { listedFscName, type NsnCopyInput } from './seo-copy';

export function nsnCopyInputFrom(page: NsnPageData): NsnCopyInput & { nsn13: string } {
  const { nsn, fsc, pricePoints, contractActions, solicitations, partNumbers } = page;
  const dates = [
    ...pricePoints.map((p) => p.awardedOn),
    ...contractActions.map((c) => c.actionDate).filter((d): d is string => d !== null),
  ].sort();
  const code = fsc?.fsc ?? nsn.fsc;
  return {
    nsn13: nsn.nsn,
    dashed: toDashedNsn(nsn.nsn),
    itemName: nsn.itemName,
    fscCode: code,
    fscName: listedFscName(code, fsc?.name),
    pricePoints: pricePoints.length,
    openSolicitations: solicitations.filter((s) => s.status === 'open').length,
    hasCharacteristics: parseCharacteristics(nsn.characteristics).length > 0,
    partNumbers: partNumbers.length,
    suppliers: new Set(partNumbers.map((p) => p.cage).filter((c): c is string => !!c)).size,
    lastPurchased: dates.at(-1) ?? null,
  };
}
