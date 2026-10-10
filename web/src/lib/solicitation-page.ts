// Request-time data loader for /solicitation/<number>/ pages.
//
// Rendered on demand by the Cloudflare Pages Function (Astro
// `prerender = false`): one solicitation, any status, any source, plus the
// awards on record that cite it. Same connection path as nsn-page.ts.
//
// Never import data.ts (or anything that pulls in `pg`) from here.

import type postgres from 'postgres';
import { assertSourceUrl, type SolicitationRecord } from './shared';
import { isSolNumber } from './entity';

type Sql = ReturnType<typeof postgres>;

export interface SolicitationAward {
  awardedOn: string;
  cage: string | null;
  supplierName: string | null;
  unitPrice: number;
  quantity: number | null;
}

export interface SolicitationPageData {
  sol: SolicitationRecord;
  /** Class name for the sol's FSC (null for placeholders and unknown classes). */
  fscName: string | null;
  /** The sol's class has an /open/<fsc>/ page (4-digit, not excluded). */
  hasOpenPage: boolean;
  awards: SolicitationAward[];
}

const isoDate = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

/** Loads one solicitation by number, or null when the number is malformed or unknown. */
export async function loadSolicitationPage(sql: Sql, solNumber: string): Promise<SolicitationPageData | null> {
  if (!isSolNumber(solNumber)) return null;

  const [solRows, awardRows] = await Promise.all([
    sql.unsafe(
      // Open means open today: a past-dated 'open' row is reported as 'expired'.
      `SELECT s.sol_number, s.nsn, s.fsc, s.nomenclature, s.quantity, s.unit_of_issue,
              s.issued_on, s.return_by,
              CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
              s.setaside, s.buyer_office, s.source, s.source_url,
              n.item_name, f.name AS fsc_name, f.render_depth AS fsc_depth
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       LEFT JOIN pub.fsc f ON f.fsc = s.fsc
       WHERE s.sol_number = $1`,
      [solNumber]
    ),
    sql.unsafe(
      `SELECT pp.awarded_on, pp.cage, su.name AS supplier_name, pp.unit_price, pp.quantity
       FROM pub.price_points pp
       LEFT JOIN pub.suppliers su ON su.cage = pp.cage
       WHERE pp.sol_number = $1
       ORDER BY pp.awarded_on DESC, pp.id DESC
       LIMIT 100`,
      [solNumber]
    ),
  ]);
  const r = solRows[0];
  if (!r) return null;

  const fscName = typeof r.fsc_name === 'string' && r.fsc_name.trim() !== '' && r.fsc_name !== `FSC ${r.fsc}` ? r.fsc_name.trim() : null;
  const sol: SolicitationRecord = {
    solNumber: r.sol_number,
    nsn: r.nsn,
    fsc: r.fsc,
    nomenclature: r.nomenclature,
    itemName: r.item_name,
    quantity: r.quantity !== null ? Number(r.quantity) : null,
    unitOfIssue: r.unit_of_issue,
    issuedOn: isoDate(r.issued_on),
    returnBy: isoDate(r.return_by),
    status: r.status,
    setaside: r.setaside,
    buyerOffice: r.buyer_office,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number}`),
  };
  return {
    sol,
    fscName,
    hasOpenPage: typeof r.fsc === 'string' && /^[0-9]{4}$/.test(r.fsc) && r.fsc_depth !== 'excluded',
    awards: awardRows.map((a) => ({
      awardedOn: isoDate(a.awarded_on)!,
      cage: a.cage,
      supplierName: a.supplier_name,
      unitPrice: Number(a.unit_price),
      quantity: a.quantity !== null ? Number(a.quantity) : null,
    })),
  };
}
