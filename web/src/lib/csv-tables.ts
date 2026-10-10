// csv-tables.ts — the rows behind the /data/*.csv downloads (build time only).
//
// Scope is deliberate: the site's own aggregates (classes, groups, agencies)
// and contract actions that come from USAspending, which is public domain.
// Row-level DIBBS and SAM.gov records are NOT published as CSV. Note that
// pub.contract_actions also holds DIBBS award rows (award_uid 'DIBBS-...'),
// so the contract-action file filters those out.

import { buildDepartments, fscDisplayName } from './browse';
import type { ContractActionRecord, SiteData } from './data';

export const classesHeaders = [
  'fsc', 'name', 'group', 'group_name', 'nsns_tracked', 'open_solicitations',
  'closing_within_7_days', 'priced_purchases', 'priced_dollars', 'as_of',
] as const;
export const groupsHeaders = ['fsg', 'name', 'classes', 'nsns_tracked', 'open_solicitations', 'as_of'] as const;
export const agenciesHeaders = ['agency', 'abbreviation', 'purchases_indexed', 'dollars_indexed', 'as_of'] as const;
export const contractActionHeaders = [
  'action_date', 'piid', 'psc', 'naics', 'description', 'obligation', 'agency', 'recipient_name', 'source_url',
] as const;

const cents = (n: number) => Math.round(n * 100) / 100;

function plusDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface ClassStats {
  nsns: number;
  open: number;
  closing: number;
  purchases: number;
  dollars: number;
}

function classStats(data: SiteData, fsc: string, asOf: string): ClassStats {
  const nsns = data.nsnsByFsc.get(fsc) ?? [];
  const sols = data.openByFsc.get(fsc)?.solicitations ?? [];
  const cutoff = plusDays(asOf, 7);
  let purchases = 0;
  let dollars = 0;
  for (const n of nsns) {
    for (const p of data.pricePointsByNsn.get(n.nsn) ?? []) {
      purchases += 1;
      dollars += p.totalValue ?? p.unitPrice * (p.quantity ?? 1);
    }
  }
  return {
    nsns: nsns.length,
    open: sols.length,
    closing: sols.filter((s) => s.returnBy !== null && s.returnBy <= cutoff).length,
    purchases,
    dollars: cents(dollars),
  };
}

/** One row per federal supply class listed on /catalog/. */
export function classesRows(data: SiteData) {
  const asOf = data.viz.today;
  return buildDepartments(data).flatMap((dept) =>
    dept.fscs.map((f) => {
      const s = classStats(data, f.fsc, asOf);
      return [f.fsc, fscDisplayName(f.fsc, f.name), dept.fsg, dept.name, s.nsns, s.open, s.closing, s.purchases, s.dollars, asOf];
    })
  );
}

/** One row per federal supply group listed on /catalog/; sums the classes in classes.csv. */
export function groupsRows(data: SiteData) {
  const asOf = data.viz.today;
  return buildDepartments(data).map((dept) => {
    const open = dept.fscs.reduce((sum, f) => sum + (data.openByFsc.get(f.fsc)?.solicitations.length ?? 0), 0);
    return [dept.fsg, dept.name, dept.fscs.length, dept.nsnCount, open, asOf];
  });
}

/** One row per agency, in the order /agencies/ ranks them. */
export function agenciesRows(data: SiteData) {
  const asOf = data.viz.today;
  return data.agencies
    .map((a) => {
      const purchases = data.purchasesByAgency.get(a.agencyId) ?? [];
      const dollars = purchases.reduce((sum, p) => sum + (p.totalValue ?? p.unitPrice * (p.quantity ?? 1)), 0);
      return { a, count: purchases.length, dollars: cents(dollars) };
    })
    .sort((x, y) => y.dollars - x.dollars || x.a.name.localeCompare(y.a.name))
    .map(({ a, count, dollars }) => [a.name, a.abbreviation, count, dollars, asOf]);
}

function isUsaspending(a: ContractActionRecord): boolean {
  if (a.awardUid.startsWith('DIBBS-')) return false;
  try {
    const host = new URL(a.sourceUrl).hostname;
    return host === 'usaspending.gov' || host.endsWith('.usaspending.gov');
  } catch {
    return false;
  }
}

const usaspendingCache = new WeakMap<SiteData, Map<string, ContractActionRecord[]>>();

/** USAspending contract actions per class (newest first); classes with none are absent. */
export function usaspendingActionsByFsc(data: SiteData): Map<string, ContractActionRecord[]> {
  const cached = usaspendingCache.get(data);
  if (cached) return cached;
  const out = new Map<string, ContractActionRecord[]>();
  for (const [fsc, actions] of data.contractActionsByFsc) {
    if (!/^\d{4}$/.test(fsc)) continue;
    const kept = actions
      .filter(isUsaspending)
      .sort((a, b) => (b.actionDate ?? '').localeCompare(a.actionDate ?? '') || a.id - b.id);
    if (kept.length > 0) out.set(fsc, kept);
  }
  usaspendingCache.set(data, out);
  return out;
}

export function contractActionRows(actions: ContractActionRecord[]) {
  return actions.map((a) => [
    a.actionDate, a.piid, a.psc, a.naics, a.description, a.obligation, a.agencyName, a.recipientName, a.sourceUrl,
  ]);
}

export const contractActionsPath = (fsc: string) => `/data/contract-actions-${fsc}.csv`;
