// Open product solicitations summarised per supply class (home page capability matcher).
import type { SolicitationRecord } from './shared';

export interface OpenItem { sol: string; nsn: string | null; name: string | null; qty: number | null; unit: string | null; closes: string | null; setaside: string | null }
export interface OpenClass { fsc: string; name: string | null; count: number; qty: number; nextClose: string | null; items: OpenItem[] }

const byClose = (a: SolicitationRecord, b: SolicitationRecord) =>
  a.returnBy === b.returnBy ? a.solNumber.localeCompare(b.solNumber) : a.returnBy === null ? 1 : b.returnBy === null ? -1 : a.returnBy.localeCompare(b.returnBy);

export function openByClass(
  openByFsc: Map<string, { fsc: string; name: string | null; solicitations: SolicitationRecord[] }>,
  keep = 5,
): OpenClass[] {
  const out: OpenClass[] = [];
  for (const { fsc, name, solicitations } of openByFsc.values()) {
    if (!/^\d{4}$/.test(fsc) || solicitations.length === 0) continue;
    const sorted = [...solicitations].sort(byClose);
    out.push({
      fsc, name,
      count: sorted.length,
      qty: sorted.reduce((s, r) => s + (r.quantity !== null && r.quantity > 0 ? r.quantity : 0), 0),
      nextClose: sorted.find((r) => r.returnBy !== null)?.returnBy ?? null,
      items: sorted.slice(0, keep).map((r) => ({ sol: r.solNumber, nsn: r.nsn, name: r.itemName ?? r.nomenclature, qty: r.quantity, unit: r.unitOfIssue, closes: r.returnBy, setaside: r.setaside })),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.fsc.localeCompare(b.fsc));
}
