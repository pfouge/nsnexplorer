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
import { pickTwin, solKeySql, type TwinRow } from './sol-twin';
import { pickSamAttachments, type SamAttachmentsView } from './sam-attachments';
import { CEILING_PRICE_POINT_SQL, CONTRACT_CEILING_SQL, NOT_CEILING_PRICE_POINT_SQL } from './contract-ceiling';

type Sql = ReturnType<typeof postgres>;

export interface SolicitationAward {
  awardedOn: string;
  cage: string | null;
  supplierName: string | null;
  unitPrice: number;
  quantity: number | null;
  /** Base award of a long-term contract (lib/contract-ceiling.ts): `unitPrice` is not a price, `ceilingAmount` is the contract's maximum value. */
  isCeiling: boolean;
  ceilingAmount: number | null;
}

export type TechDocs = 'none' | 'tech_docs' | 'spec_only';

export interface PartPrice {
  awardedOn: string;
  unitPrice: number;
  quantity: number | null;
  cage: string | null;
  supplierName: string | null;
  solNumber: string | null;
  sourceUrl: string;
  /** Base award of a long-term contract: kept so past winners still count it; `unitPrice` is not a price. */
  isCeiling: boolean;
}

export interface MatchedAward {
  awardNumber: string | null;
  deliveryOrder: string | null;
  actionDate: string | null;
  cage: string | null;
  supplierName: string | null;
  total: number | null;
  /** Base award of a long-term contract: `total` is the contract's ceiling, not money spent. */
  isCeiling: boolean;
  sourceUrl: string;
}

/** DIBBS "Tech Docs" column text to a small code (null when absent or unrecognised). */
export function mapTechDocs(v: unknown): TechDocs | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === 'None') return 'none';
  if (t === 'Tech Docs') return 'tech_docs';
  if (t === 'Tech Docs *Spec/Stnd Only') return 'spec_only';
  return null;
}

export interface SolicitationPageData {
  sol: SolicitationRecord;
  /** Class name for the sol's FSC (null for placeholders and unknown classes). */
  fscName: string | null;
  /** The sol's class has an /open/<fsc>/ page (4-digit, not excluded). */
  hasOpenPage: boolean;
  awards: SolicitationAward[];
  /** DIBBS purchase request number (trimmed), null when absent. */
  purchaseRequest: string | null;
  techDocs: TechDocs | null;
  /** Up to 20 most recent price points for the same NSN, any solicitation. */
  partPrices: PartPrice[];
  /** Total price points for the NSN, long-term contract base awards not counted (they carry no price). */
  partPriceCount: number;
  /** DIBBS award records for the same NSN carrying this solicitation's purchase request. */
  matchedAwards: MatchedAward[];
  /** pub.nsns.characteristics of the solicitation's NSN (raw jsonb; parse with parseCharacteristics), null when the NSN is not in the catalog. */
  characteristics: unknown;
  /** Up to 25 part numbers on file for the NSN (pub.part_numbers), for standard-document detection and nothing else. */
  partNumbers: { partNumber: string; cage: string | null }[];
  /** The same requirement on the other source (rule in sol-twin.ts), with the official record's link; null when there is none or it is not certain. */
  twin: TwinRow | null;
  /** Files the SAM.gov notice lists (this page's own notice, or the twin's on a DIBBS page); null when none. See sam-attachments.ts. */
  samAttachments: SamAttachmentsView | null;
}

const isoDate = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

/**
 * One statement (one Hyperdrive round-trip): the solicitation row as ordinary
 * columns plus its awards as a jsonb array. No row means no such solicitation.
 */
const SOLICITATION_PAGE_SQL = `
WITH same_key AS (
  -- Every row whose number is the same once separators are dropped (this row included): at most five are read, one
  -- index probe (migration 0016). pickTwin() decides from them whether there is exactly one twin on the other source.
  SELECT t.sol_number, t.source, t.source_url,
         -- SAM.gov attachment links (sam-attachments.ts): only the one key of the stored notice, never the whole record
         CASE WHEN t.source = 'sam_gov' THEN t.raw -> 'resourceLinks' END AS resource_links
  FROM pub.solicitations t
  WHERE ${solKeySql('t')} = regexp_replace(upper($1::text), '[^A-Z0-9]', '', 'g')
  ORDER BY t.sol_number
  LIMIT 5
)
SELECT s.sol_number, s.nsn, s.fsc, s.nomenclature, s.quantity, s.unit_of_issue,
       s.issued_on, s.return_by,
       -- Open means open today: a past-dated 'open' row is reported as 'expired'.
       CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
       s.setaside, s.buyer_office, s.source, s.source_url,
       CASE WHEN s.source = 'sam_gov' THEN s.raw -> 'resourceLinks' END AS resource_links, -- SAM.gov attachments (sam-attachments.ts)
       n.item_name, n.characteristics AS characteristics, f.name AS fsc_name, f.render_depth AS fsc_depth,
       -- Part numbers for the "Drawings and technical data" block (standard sheets such as MS35338-44): primary-key-free
       -- index lookup on part_numbers (nsn), capped at 25.
       (SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.part_number, q.cage), '[]'::jsonb)
          FROM (SELECT pn.part_number, pn.cage
                FROM pub.part_numbers pn
                WHERE pn.nsn = s.nsn
                ORDER BY pn.part_number, pn.cage
                LIMIT 25) q) AS part_number_rows,
       (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.awarded_on DESC, a.id DESC), '[]'::jsonb)
          FROM (SELECT pp.id, pp.awarded_on, pp.cage, su.name AS supplier_name, pp.unit_price, pp.quantity,
                       ${CEILING_PRICE_POINT_SQL} AS is_ceiling, pp.total_value AS ceiling_amount
                FROM pub.price_points pp
                LEFT JOIN pub.suppliers su ON su.cage = pp.cage
                WHERE pp.sol_number = s.sol_number
                ORDER BY pp.awarded_on DESC, pp.id DESC
                LIMIT 100) a) AS award_rows,
       NULLIF(btrim(s.raw ->> 'purchaseRequest'), '') AS purchase_request,
       s.raw ->> 'techDocs' AS tech_docs,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.awarded_on DESC, p.id DESC), '[]'::jsonb)
          FROM (SELECT pp.id, pp.awarded_on, pp.unit_price, pp.quantity, pp.cage, su.name AS supplier_name,
                       pp.sol_number, pp.source_url, ${CEILING_PRICE_POINT_SQL} AS is_ceiling
                FROM pub.price_points pp
                LEFT JOIN pub.suppliers su ON su.cage = pp.cage
                WHERE pp.nsn = s.nsn
                ORDER BY pp.awarded_on DESC, pp.id DESC
                LIMIT 20) p) AS part_price_rows,
       (SELECT count(*) FROM pub.price_points pp WHERE pp.nsn = s.nsn AND ${NOT_CEILING_PRICE_POINT_SQL}) AS part_price_count,
       (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.action_date DESC NULLS LAST, m.award_number DESC NULLS LAST), '[]'::jsonb)
          FROM (SELECT ca.raw ->> 'awardNumber' AS award_number, ca.raw ->> 'deliveryOrder' AS delivery_order,
                       ca.action_date, ca.raw ->> 'cage' AS cage, su.name AS supplier_name,
                       COALESCE(ca.obligation,
                                CASE WHEN regexp_replace(COALESCE(ca.raw ->> 'total', ''), '[$,[:space:]]', '', 'g') ~ '^-?[0-9]+([.][0-9]+)?$'
                                     THEN regexp_replace(ca.raw ->> 'total', '[$,[:space:]]', '', 'g')::numeric END) AS total,
                       ca.source_url, ${CONTRACT_CEILING_SQL} AS is_ceiling
                FROM pub.contract_actions ca
                LEFT JOIN pub.suppliers su ON su.cage = ca.raw ->> 'cage'
                WHERE ca.award_uid LIKE 'DIBBS%'
                  AND ca.raw ->> 'nsn' = s.nsn
                  AND NULLIF(btrim(s.raw ->> 'purchaseRequest'), '') IS NOT NULL
                  AND btrim(ca.raw ->> 'purchaseRequest') = btrim(s.raw ->> 'purchaseRequest')
                ORDER BY ca.action_date DESC NULLS LAST, ca.raw ->> 'awardNumber' DESC NULLS LAST
                LIMIT 20) m) AS matched_award_rows,
       (SELECT COALESCE(jsonb_agg(to_jsonb(k) ORDER BY k.sol_number), '[]'::jsonb) FROM same_key k) AS same_key_rows
FROM pub.solicitations s
LEFT JOIN pub.nsns n ON n.nsn = s.nsn
LEFT JOIN pub.fsc f ON f.fsc = s.fsc
WHERE s.sol_number = $1`;

/** Loads one solicitation by number in a single round-trip, or null when the number is malformed or unknown. */
export async function loadSolicitationPage(sql: Sql, solNumber: string): Promise<SolicitationPageData | null> {
  if (!isSolNumber(solNumber)) return null;

  const r = (await sql.unsafe(SOLICITATION_PAGE_SQL, [solNumber]))[0];
  if (!r) return null;
  const partRows = r.part_price_rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const matchedRows = r.matched_award_rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const awardRows = r.award_rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sameKeyRows = (r.same_key_rows as { sol_number: string; source: string; source_url: string }[]).map((k) => ({
    solNumber: k.sol_number,
    source: k.source,
    sourceUrl: k.source_url,
  }));
  const twin = pickTwin({ solNumber: r.sol_number, source: r.source }, sameKeyRows);
  const twinLinks = twin ? (r.same_key_rows as { sol_number: string; resource_links?: unknown }[]).find((k) => k.sol_number === twin.solNumber)?.resource_links : null;
  const samAttachments = pickSamAttachments(
    { source: r.source, solNumber: r.sol_number, sourceUrl: r.source_url, resourceLinks: r.resource_links },
    twin ? { source: twin.source, solNumber: twin.solNumber, sourceUrl: twin.sourceUrl, resourceLinks: twinLinks } : null
  );

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
    techDocs: null,
    awardFound: false,
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
      isCeiling: a.is_ceiling === true,
      ceilingAmount: a.is_ceiling === true && a.ceiling_amount !== null && a.ceiling_amount !== undefined ? Number(a.ceiling_amount) : null,
    })),
    purchaseRequest: typeof r.purchase_request === 'string' ? r.purchase_request : null,
    techDocs: mapTechDocs(r.tech_docs),
    characteristics: r.characteristics ?? null,
    partNumbers: ((r.part_number_rows ?? []) as { part_number: string; cage: string | null }[]).map((p) => ({ partNumber: p.part_number, cage: p.cage ?? null })),
    partPrices: partRows.map((p) => ({
      awardedOn: isoDate(p.awarded_on)!,
      unitPrice: Number(p.unit_price),
      quantity: p.quantity !== null && p.quantity !== undefined ? Number(p.quantity) : null,
      cage: p.cage ?? null,
      supplierName: p.supplier_name ?? null,
      solNumber: p.sol_number ?? null,
      sourceUrl: assertSourceUrl(p.source_url, `price_points.id=${p.id}`),
      isCeiling: p.is_ceiling === true,
    })),
    partPriceCount: Number(r.part_price_count),
    matchedAwards: matchedRows.map((m) => ({
      awardNumber: m.award_number ?? null,
      deliveryOrder: m.delivery_order ?? null,
      actionDate: isoDate(m.action_date),
      cage: m.cage ?? null,
      supplierName: m.supplier_name ?? null,
      total: m.total !== null && m.total !== undefined ? Number(m.total) : null,
      isCeiling: m.is_ceiling === true,
      sourceUrl: assertSourceUrl(m.source_url, `contract_actions award ${m.award_number}`),
    })),
    twin: twin ? { ...twin, sourceUrl: assertSourceUrl(twin.sourceUrl, `solicitations.sol_number=${twin.solNumber} (twin)`) } : null,
    samAttachments,
  };
}
