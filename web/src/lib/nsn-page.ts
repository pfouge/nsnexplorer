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
 * with its latest AMSC observation, plus the five child sets as jsonb arrays
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
                  pp.sol_number, pp.award_ref, pp.source, pp.source_url, pp.ingested_at
           FROM pub.price_points pp
           LEFT JOIN pub.suppliers s ON s.cage = pp.cage
           LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
           WHERE pp.nsn = base.nsn) p) AS price_points,
  (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.action_date, c.id), '[]'::jsonb)
     FROM (SELECT ca.id, ca.award_uid, ca.piid, ca.psc, ca.naics, ca.description, ca.action_date,
                  ca.obligation, ca.agency_id, ag.name AS agency_name, ca.recipient_name,
                  ca.recipient_uei, ca.source_url, ca.ingested_at,
                  NULLIF(btrim(ca.raw ->> 'cage'), '') AS cage
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
              n.item_name
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       WHERE s.nsn = base.nsn) q) AS solicitations,
  (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.part_number, r.cage, r.id), '[]'::jsonb)
     FROM (SELECT pn.id, pn.nsn, pn.part_number, pn.cage, pn.source, pn.source_url, s.name AS supplier_name
           FROM pub.part_numbers pn
           LEFT JOIN pub.suppliers s ON s.cage = pn.cage
           WHERE pn.nsn = base.nsn) r) AS part_numbers
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

  return { nsn, fsc, pricePoints, contractActions, solicitations, partNumbers, agencies: [...agencyMap.values()] };
}
