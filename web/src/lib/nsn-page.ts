// Request-time data loader for /nsn/[nsn]/ pages.
//
// NSN pages are rendered on demand by the Cloudflare Pages Function (Astro
// `prerender = false`) rather than at build time: Cloudflare Pages caps a
// deployment at 20,000 files and the catalog is far larger than that. This
// module queries Postgres for ONE NSN using the `postgres` driver over the
// Hyperdrive binding (the same path /api/signup uses), and returns the same
// record shapes the build-time loader (data.ts) produces so the page
// template is shared unchanged.
//
// Never import data.ts (or anything that pulls in `pg`) from here: this file
// is bundled into the Workers runtime, which has no Node sockets.

import postgres from 'postgres';
import {
  type AgencyRecord,
  type ContractActionRecord,
  type FscConfig,
  type NsnRecord,
  type PartNumberRecord,
  type PricePointRecord,
  type SolicitationRecord,
  NSN_WITH_AMSC_SELECT,
  assertSourceUrl,
  mapNsnRow,
  slugify,
} from './shared';
import { type NsnFlis, mapFlis } from './nsn-flis';
import { CEILING_PRICE_POINT_SQL, CONTRACT_CEILING_SQL } from './contract-ceiling';
import { mapTechDocs } from './solicitation-page';

/** A contract action plus the awardee's CAGE when the source carried one (DIBBS award grid rows do). */
export interface NsnContractAction extends ContractActionRecord {
  cage: string | null;
}

export interface NsnPageData {
  nsn: NsnRecord;
  fsc: FscConfig | null;
  pricePoints: PricePointRecord[];
  contractActions: NsnContractAction[];
  /** Every solicitation on record for this NSN (any status), newest first. */
  solicitations: SolicitationRecord[];
  partNumbers: PartNumberRecord[];
  /** Agencies referenced by this NSN's priced purchases, keyed by id. */
  agencies: AgencyRecord[];
  /** FLIS catalog record (migration 0014): identification codes, related items, replaced stock numbers, MOE rules. */
  flis: NsnFlis;
}

type Sql = ReturnType<typeof postgres>;

/** One element of a jsonb child array from the single-statement loaders (JSON-typed column values). */
type JsonRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Opens a single short-lived connection through Hyperdrive (or DATABASE_URL locally). */
/**
 * Short, secret-free label for a failed database call (driver error name,
 * Postgres/Node error code, first 60 characters of the message with anything
 * that looks like a host or credential removed). Logged to the Worker log and
 * sent in an x-nsn-db-error header on the JSON endpoints so an outage can be
 * diagnosed without dashboard access.
 */
export function dbErrorTag(err: unknown): string {
  const e = (err ?? {}) as { name?: string; code?: string; message?: string };
  const msg = String(e.message ?? '')
    .replace(/[a-z0-9.-]+\.(com|net|co|io|supabase\.[a-z]+)\S*/gi, '<host>')
    .replace(/user "[^"]*"/gi, 'user "<u>"')
    .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return [e.name, e.code, msg].filter(Boolean).join(' | ');
}

export function openSql(connectionString: string): Sql {
  return postgres(connectionString, { prepare: false, max: 1, fetch_types: false });
}

const isoDate = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

/**
 * The whole NSN page in ONE statement (one Hyperdrive round-trip): the NSN row
 * with its latest AMSC observation, plus the five child sets (and the FLIS catalog record) as jsonb
 * built by correlated sub-selects. Zero rows means the NSN does not exist.
 *
 * Why one statement: Hyperdrive's free plan stops after 100,000 queries a day
 * and this page used to cost six. JSON changes the wire types (numerics, bigint
 * and dates arrive as JSON numbers / strings, timestamps as ISO strings); every
 * consumer below already normalises with Number(), isoDate() and
 * new Date(...).toISOString(), which accept both the driver's text/Date values
 * and the JSON ones, so the returned objects are unchanged.
 *
 * Orders carry an `id` tiebreaker (the old queries left equal dates in
 * unspecified order); everything else is the previous predicate, ORDER BY and
 * column list verbatim.
 */
const NSN_PAGE_SQL = `
SELECT base.*,
  (SELECT to_jsonb(f)
     FROM (SELECT fsc, name, fsg, render_depth FROM pub.fsc WHERE fsc = base.fsc) f) AS fsc_row,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.awarded_on, p.id), '[]'::jsonb)
     FROM (SELECT pp.id, pp.nsn, pp.awarded_on, pp.unit_price, pp.quantity, pp.total_value,
                  pp.cage, s.name AS supplier_name, s.city AS supplier_city, s.state AS supplier_state,
                  pp.agency_id, ag.name AS agency_name, ag.abbreviation AS agency_abbr,
                  pp.sol_number, pp.award_ref, pp.source, pp.source_url, pp.ingested_at,
                  ${CEILING_PRICE_POINT_SQL} AS is_ceiling
           FROM pub.price_points pp
           LEFT JOIN pub.suppliers s ON s.cage = pp.cage
           LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
           WHERE pp.nsn = base.nsn) p) AS price_points,
  (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.action_date, c.id), '[]'::jsonb)
     FROM (SELECT ca.id, ca.award_uid, ca.piid, ca.psc, ca.naics, ca.description, ca.action_date,
                  ca.obligation, ca.agency_id, ag.name AS agency_name, ca.recipient_name,
                  ca.recipient_uei, ca.source_url, ca.ingested_at,
                  NULLIF(btrim(ca.raw ->> 'cage'), '') AS cage,
                  ${CONTRACT_CEILING_SQL} AS is_ceiling
           FROM pub.contract_actions ca
           LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
           WHERE (ca.raw ->> 'nsn') = base.nsn::text) c) AS contract_actions,
  (SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY COALESCE(q.return_by, q.issued_on) DESC NULLS LAST, q.sol_number), '[]'::jsonb)
     FROM (
       -- Open means open today: past-dated 'open' rows are reported as 'expired'.
       SELECT s.sol_number, s.nsn, s.fsc, s.nomenclature, s.quantity, s.unit_of_issue,
              s.issued_on, s.return_by,
              CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
              s.setaside, s.buyer_office, s.source, s.source_url,
              s.raw ->> 'techDocs' AS tech_docs,
              n.item_name
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       WHERE s.nsn = base.nsn) q) AS solicitations,
  (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.part_number, r.cage, r.id), '[]'::jsonb)
     FROM (SELECT pn.id, pn.nsn, pn.part_number, pn.cage, pn.source, pn.source_url, s.name AS supplier_name
           FROM pub.part_numbers pn
           LEFT JOIN pub.suppliers s ON s.cage = pn.cage
           WHERE pn.nsn = base.nsn) r) AS part_numbers,
  -- FLIS catalog record (migration 0014). Code labels come from pub.flis_codes by primary key ('FIELD:VALUE'
  -- and bare field names for definitions); every sub-select below is a primary-key or index lookup.
  (SELECT to_jsonb(i)
     FROM (SELECT ni.inc, ni.crit_cd, ni.demil, ni.demil_int_cd, ni.niin_assigned, ni.pmic, ni.adp, ni.hmic,
                  ni.esd_emi, ni.hcc, ni.schedule_b, ni.enac, ni.iuid_indicator, ni.last_known_sos, ni.source_file_date,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'PMIC:' || ni.pmic) AS pmic_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'HMIC:' || ni.hmic) AS hmic_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'HCC:' || ni.hcc) AS hcc_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'ENAC:' || ni.enac) AS enac_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'IUID_INDICATOR:' || ni.iuid_indicator) AS iuid_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'LST_KWN_SOS:' || ni.last_known_sos) AS sos_label,
                  (SELECT fc.description FROM pub.flis_codes fc WHERE fc.code = 'SCHEDULE_B:' || ni.schedule_b) AS schedule_b_text,
                  (SELECT COALESCE(jsonb_agg(jsonb_build_object('field', fd.code, 'literal', fd.literal, 'description', left(fd.description, 900)) ORDER BY fd.code), '[]'::jsonb)
                     FROM pub.flis_codes fd
                    WHERE fd.code = ANY (ARRAY[
                      CASE WHEN ni.niin_assigned IS NOT NULL THEN 'NIIN_ASGMT' END,
                      CASE WHEN ni.hmic IS NOT NULL THEN 'HMIC' END,
                      CASE WHEN ni.pmic IS NOT NULL THEN 'PMIC' END,
                      CASE WHEN ni.schedule_b IS NOT NULL THEN 'SCHEDULE_B' END,
                      CASE WHEN ni.hcc IS NOT NULL THEN 'HCC' END,
                      CASE WHEN ni.enac IS NOT NULL THEN 'ENAC' END,
                      CASE WHEN ni.iuid_indicator IS NOT NULL THEN 'IUID_INDICATOR' END,
                      CASE WHEN ni.last_known_sos IS NOT NULL THEN 'LST_KWN_SOS' END])) AS field_defs
           FROM pub.nsn_identification ni
           WHERE ni.nsn = base.nsn) i) AS flis_ident,
  (SELECT COALESCE(jsonb_agg(cn.colloquial_name ORDER BY cn.colloquial_name), '[]'::jsonb)
     FROM (SELECT icn.colloquial_name
           FROM pub.inc_colloquial_names icn
           WHERE icn.inc = (SELECT ni2.inc FROM pub.nsn_identification ni2 WHERE ni2.nsn = base.nsn)
           ORDER BY icn.colloquial_name
           LIMIT 8) cn) AS flis_colloquial,
  (SELECT COALESCE(jsonb_agg(to_jsonb(rel) ORDER BY rel.related_nsn), '[]'::jsonb)
     FROM (SELECT st.related_nsn, st.isc, st.stdzn_date,
                  (length(st.related_nsn) = 13 AND EXISTS (SELECT 1 FROM pub.nsns rn WHERE rn.nsn = st.related_nsn::char(13))) AS has_page,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'ISC:' || st.isc) AS isc_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'ORIG_STDZN_DEC:' || st.orig_stdzn_dec) AS dec_label,
                  count(*) OVER () AS total
           FROM pub.nsn_standardization st
           WHERE st.nsn = base.nsn AND st.related_nsn <> ''
           ORDER BY st.related_nsn
           LIMIT 50) rel) AS flis_related,
  -- nsn/niin is the item we track (the survivor); cancelled_niin is the older number cancelled in its favour.
  -- niin must match this NSN's own NIIN: a row kept only because the cancelled side is tracked is not ours.
  (SELECT COALESCE(jsonb_agg(to_jsonb(cx) ORDER BY cx.eff_date DESC NULLS LAST, cx.cancelled_niin), '[]'::jsonb)
     FROM (SELECT nc.cancelled_niin_fsc AS cancelled_fsc, nc.cancelled_niin, nc.niin_stat_cd AS status, nc.eff_date,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'NIIN_STAT_CD:' || nc.niin_stat_cd) AS status_label,
                  count(*) OVER () AS total
           FROM pub.nsn_cancellations nc
           WHERE nc.nsn = base.nsn AND nc.niin = base.niin
           ORDER BY nc.eff_date DESC NULLS LAST, nc.cancelled_niin
           LIMIT 25) cx) AS flis_cancel,
  (SELECT COALESCE(jsonb_agg(to_jsonb(mx) ORDER BY mx.moe_cd, mx.moe_rl), '[]'::jsonb)
     FROM (SELECT m.moe_rl, m.moe_cd, m.amc, m.amsc, m.nimsc, m.assigned_on, m.imc, m.aac, m.pica, m.sica,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'MOE_CD:' || m.moe_cd) AS moe_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'AMC:' || m.amc) AS amc_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'AMSC:' || m.amsc) AS amsc_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'AAC:' || m.aac) AS aac_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'IMC:' || m.imc) AS imc_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'PICA:' || m.pica) AS pica_label,
                  (SELECT fc.literal FROM pub.flis_codes fc WHERE fc.code = 'SICA:' || m.sica) AS sica_label
           FROM pub.moe_rules m
           WHERE m.nsn = base.nsn) mx) AS flis_moe
FROM (${NSN_WITH_AMSC_SELECT} WHERE n.nsn = $1) base`;

/**
 * Loads everything the NSN page renders for one 13-digit NSN code, in a single
 * database round-trip. Returns null when the NSN is not in pub.nsns (the route
 * answers 404).
 */
export async function loadNsnPage(sql: Sql, nsnCode: string): Promise<NsnPageData | null> {
  if (!/^\d{13}$/.test(nsnCode)) return null;

  const rows = await sql.unsafe(NSN_PAGE_SQL, [nsnCode]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const nsn = mapNsnRow(row as unknown as Parameters<typeof mapNsnRow>[0]);
  const fscRow = row.fsc_row as { fsc: string; name: string; fsg: string; render_depth: string } | null;
  const ppRows = row.price_points as JsonRow[];
  const caRows = row.contract_actions as JsonRow[];
  const solRows = row.solicitations as JsonRow[];
  const pnRows = row.part_numbers as JsonRow[];

  const fsc: FscConfig | null = fscRow
    ? { fsc: fscRow.fsc, name: fscRow.name, fsg: fscRow.fsg, renderDepth: fscRow.render_depth }
    : null;

  const agencyMap = new Map<number, AgencyRecord>();
  const pricePoints: PricePointRecord[] = ppRows.map((r) => {
    const rec: PricePointRecord = {
      id: Number(r.id),
      nsn: r.nsn,
      awardedOn: isoDate(r.awarded_on)!,
      unitPrice: Number(r.unit_price),
      quantity: r.quantity !== null ? Number(r.quantity) : null,
      totalValue: r.total_value !== null ? Number(r.total_value) : null,
      cage: r.cage,
      supplierName: r.supplier_name,
      supplierCity: r.supplier_city,
      supplierState: r.supplier_state,
      agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
      agencyName: r.agency_name,
      agencyAbbr: r.agency_abbr,
      solNumber: r.sol_number,
      awardRef: r.award_ref,
      source: r.source,
      sourceUrl: assertSourceUrl(r.source_url, `price_points.id=${r.id} nsn=${r.nsn}`),
      ingestedAt: new Date(r.ingested_at).toISOString(),
      isCeiling: r.is_ceiling === true,
    };
    // Same slug rule as data.ts, so links land on the static /agency/ pages
    // (which exist for every agency with at least one priced purchase).
    if (rec.agencyId !== null && !agencyMap.has(rec.agencyId)) {
      agencyMap.set(rec.agencyId, {
        agencyId: rec.agencyId,
        name: rec.agencyName ?? `Agency ${rec.agencyId}`,
        abbreviation: rec.agencyAbbr,
        slug: slugify(rec.agencyName ?? `agency-${rec.agencyId}`),
      });
    }
    return rec;
  });

  const contractActions: NsnContractAction[] = caRows.map((r) => ({
    id: Number(r.id),
    awardUid: r.award_uid,
    piid: r.piid,
    psc: r.psc,
    naics: r.naics,
    description: r.description,
    actionDate: isoDate(r.action_date),
    obligation: r.obligation !== null ? Number(r.obligation) : null,
    agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
    agencyName: r.agency_name,
    recipientName: r.recipient_name,
    recipientUei: r.recipient_uei,
    sourceUrl: assertSourceUrl(r.source_url, `contract_actions.id=${r.id}`),
    ingestedAt: new Date(r.ingested_at).toISOString(),
    isCeiling: r.is_ceiling === true,
    cage: r.cage ?? null,
  }));

  const solicitations: SolicitationRecord[] = solRows.map((r) => ({
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
    techDocs: mapTechDocs(r.tech_docs),
    awardFound: false,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number}`),
  }));

  const partNumbers: PartNumberRecord[] = pnRows.map((r) => ({
    partNumber: r.part_number,
    cage: r.cage,
    supplierName: r.supplier_name,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `part_numbers ${r.nsn}/${r.part_number}`),
  }));

  const flis = mapFlis(row as unknown as Parameters<typeof mapFlis>[0]);

  return { nsn, fsc, pricePoints, contractActions, solicitations, partNumbers, agencies: [...agencyMap.values()], flis };
}
