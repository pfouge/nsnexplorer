// csv-tables.ts — the rows behind the /data/*.csv downloads (build time only).
//
// Scope is deliberate: the site's own aggregates (classes, groups, agencies)
// and contract actions that come from USAspending, which is public domain.
// Row-level DIBBS and SAM.gov records are NOT published as CSV. Note that
// pub.contract_actions also holds DIBBS award rows (award_uid 'DIBBS-...'),
// so the contract-action file filters those out.

import { buildClassTotals, buildDepartments, fscDisplayName } from './browse';
import type { SiteData } from './data';
import { hasUsaspendingActions, usaspendingFiscalYears } from './class-actions';

export const classesHeaders = [
  'fsc', 'name', 'group', 'group_name', 'nsns_tracked', 'open_solicitations',
  'closing_within_7_days', 'priced_purchases', 'priced_dollars', 'as_of',
] as const;
export const groupsHeaders = ['fsg', 'name', 'classes', 'nsns_tracked', 'open_solicitations', 'as_of'] as const;
export const agenciesHeaders = ['agency', 'abbreviation', 'purchases_indexed', 'dollars_indexed', 'contract_actions', 'obligated', 'as_of'] as const;
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
  // The class page's "Purchase records" and "Total $": each award once, long-term contract ceilings left out
  // (lib/class-totals.ts), category-level contract actions included.
  const { purchases, dollars } = buildClassTotals(data, fsc);
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
      const prof = data.agencyProfiles.get(a.agencyId);
      return { a, count: purchases.length, dollars: cents(dollars), actions: prof?.actions ?? 0, obligated: cents(prof?.obligated ?? 0) };
    })
    .sort((x, y) => y.obligated - x.obligated || y.dollars - x.dollars || x.a.name.localeCompare(y.a.name))
    .map(({ a, count, dollars, actions, obligated }) => [a.name, a.abbreviation, count, dollars, actions, obligated, asOf]);
}

/**
 * Classes that have a USAspending CSV download, with their fiscal years (newest first).
 * A class is listed when it has any USAspending class-level row, dated or not, so a class
 * whose rows are all undated still gets its (empty) 12-month file but no per-year files.
 * Computed in SQL (lib/class-actions-db.ts); the rows themselves are queried per file.
 */
export function usaspendingCsvClasses(data: SiteData): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [fsc, summary] of data.contractActionSummaryByFsc) {
    if (/^\d{4}$/.test(fsc) && hasUsaspendingActions(summary)) out.set(fsc, usaspendingFiscalYears(summary));
  }
  return out;
}

export const contractActionsPath = (fsc: string) => `/data/contract-actions-${fsc}.csv`;
export { contractActionsFyPath, csvFiscalYear, CSV_MAX_ROWS } from './csv-split';
