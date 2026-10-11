// Request-time data loader for /supplier/<CAGE>/ pages.
//
// Supplier pages are rendered on demand by the Cloudflare Pages Function
// (Astro `prerender = false`), like the NSN pages: one short-lived connection
// through Hyperdrive, a handful of aggregate queries, no build-time loader.
// A supplier has a page only when it has at least one row in pub.price_points.
//
// Never import data.ts (or anything that pulls in `pg`) from here: this file
// is bundled into the Workers runtime, which has no Node sockets.
//
// Privacy: the CAGE file contributes only the supplier's name and "City, ST".
// Street addresses, mailing addresses, points of contact and the company's own
// phone/email come from supplier_sam / supplier_web and are removed INSIDE the
// statement (jsonb key deletion) when the supplier is in pub.supplier_optouts,
// so an opted-out supplier's contact data never leaves the database.

import type postgres from 'postgres';
import { assertSourceUrl, slugify } from './shared.ts';

type Sql = ReturnType<typeof postgres>;

/** One element of a jsonb child array from the single-statement loader (JSON-typed column values). */
type JsonRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Awards listed on the page; the headline numbers always cover every award. */
export const SUPPLIER_AWARD_ROWS = 200;

export interface SupplierAward {
  awardedOn: string;
  nsn: string;
  itemName: string | null;
  quantity: number | null;
  unitPrice: number;
  /** Recorded total, or unit price x quantity when the source gave none; null when neither is known. */
  total: number | null;
  agencyName: string | null;
  agencySlug: string | null;
  source: string;
  sourceUrl: string;
}

export interface SupplierClass {
  fsc: string;
  /** Real class name; null for ingest placeholders ("FSC 7310") and blanks. */
  name: string | null;
  awards: number;
  /** Where the class code links: its price-history page, its open-demand page, or nowhere. */
  link: 'fsc' | 'open' | null;
}

export interface SupplierPoc {
  role: string | null;
  name: string | null;
  title: string | null;
}
export interface SupplierSba {
  label: string;
  entry: string | null;
  exit: string | null;
}
export interface SupplierNaics {
  code: string;
  small: boolean | null;
}
/** pub.supplier_sam (public SAM.gov entity record). Contact fields are null when the supplier opted out. */
export interface SupplierSam {
  uei: string | null;
  legalName: string | null;
  dbaName: string | null;
  entityUrl: string | null;
  physical: SupplierAddress | null;
  mailing: SupplierAddress | null;
  registrationStatus: string | null;
  registrationDate: string | null;
  expirationDate: string | null;
  lastUpdateDate: string | null;
  activationDate: string | null;
  entityStartDate: string | null;
  entityStructure: string | null;
  stateOfIncorporation: string | null;
  businessTypes: string[];
  sbaCertifications: SupplierSba[];
  primaryNaics: string | null;
  naics: SupplierNaics[];
  psc: string[];
  pocs: SupplierPoc[];
  sourceFile: string | null;
  syncedAt: string | null;
}
export interface SupplierAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  zip4: string | null;
  country: string | null;
}
export interface SupplierWebPage {
  url: string;
  title: string | null;
}
/** pub.supplier_web. Null on the page data when absent or when the supplier opted out of the web profile. */
export interface SupplierWeb {
  url: string;
  finalUrl: string | null;
  status: string;
  fetchedAt: string;
  pages: SupplierWebPage[];
  summary: string | null;
  products: string[];
  capabilities: string[];
  certifications: string[];
  founded: number | null;
  /** Phone, email and the page they came from: null when the supplier opted out of contact details. */
  phone: string | null;
  email: string | null;
  contactUrl: string | null;
  metaDescription: string | null;
  model: string | null;
}
/** pub.supplier_stats, as refreshed daily. */
export interface SupplierStats {
  awardsAll: number;
  dollarsAll: number;
  awards12m: number;
  dollars12m: number;
  awardsPrior12m: number;
  dollarsPrior12m: number;
  nsns: number;
  fscs: number;
  agencies: number;
  firstAward: string;
  lastAward: string;
  rankDollars12m: number | null;
  rankDollarsAll: number | null;
  rankWins12m: number | null;
  rankWinsAll: number | null;
  rankNsns: number | null;
  rankFscs: number | null;
  rankRising: number | null;
  risingDelta: number | null;
  refreshedAt: string;
}
export interface SupplierMonth {
  /** 'YYYY-MM' */
  month: string;
  awards: number;
  dollars: number;
}
export interface SupplierTopNsn {
  nsn: string;
  itemName: string | null;
  awards: number;
  dollars: number;
  lastAward: string;
}
export interface SupplierAgency {
  name: string;
  slug: string;
  awards: number;
  dollars: number;
  lastAward: string;
}
export interface SupplierContractAction {
  actionDate: string | null;
  agencyName: string | null;
  psc: string | null;
  description: string | null;
  obligation: number | null;
  piid: string | null;
  sourceUrl: string;
}
export interface SupplierPart {
  nsn: string;
  itemName: string | null;
  partNumber: string;
}
export interface SupplierOpenBid {
  solNumber: string;
  nsn: string;
  itemName: string | null;
  quantity: number | null;
  unitOfIssue: string | null;
  returnBy: string | null;
  source: string;
  sourceUrl: string;
}

export interface SupplierPageData {
  cage: string;
  name: string | null;
  city: string | null;
  state: string | null;
  awards: number;
  /** Sum of recorded totals (or unit price x quantity); awards with neither add nothing. */
  dollars: number;
  /** How many awards carry a dollar figure. */
  valuedAwards: number;
  nsns: number;
  classes: number;
  firstAward: string;
  latestAward: string;
  rows: SupplierAward[];
  classRows: SupplierClass[];
  /** Most recent ingest timestamp across this supplier's awards (ISO), for "last refreshed". */
  refreshedOn: string | null;
  /** True when the CAGE is listed as a maker on pub.part_numbers (the "Follow as manufacturer" toggle). */
  makesParts: boolean;
  /** The database's CURRENT_DATE (ISO), so "last 24 months" and "open today" agree with the SQL. */
  today: string;
  /** UEI from the SAM record, else from pub.suppliers. */
  uei: string | null;
  sam: SupplierSam | null;
  web: SupplierWeb | null;
  stats: SupplierStats | null;
  /** Flags from pub.supplier_optouts; both false when the supplier has no row. */
  optout: { hideContact: boolean; hideWeb: boolean };
  /** The last 24 calendar months ending with the current one, oldest first, zero-filled. */
  months: SupplierMonth[];
  topNsns: SupplierTopNsn[];
  /** Agencies named on this supplier's awards (up to 15), most awards first. */
  agencyRows: SupplierAgency[];
  usaspending: { count: number; total: number; rows: SupplierContractAction[] };
  parts: { count: number; rows: SupplierPart[] };
  openBids: { total: number; rows: SupplierOpenBid[] };
}

export const SUPPLIER_TOP_NSNS = 10;
export const SUPPLIER_AGENCY_ROWS = 15;
export const SUPPLIER_USA_ROWS = 25;
export const SUPPLIER_PART_ROWS = 50;
export const SUPPLIER_OPEN_ROWS = 25;
export const SUPPLIER_MONTHS = 24;

const isoDate = (v: unknown): string => new Date(v as string).toISOString().slice(0, 10);
const isoDateOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : isoDate(v));
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(clean).filter((x): x is string => x !== null) : []);

/** Supplier award value: the recorded total, else unit price x quantity. */
const VALUE_SQL = 'COALESCE(pp.total_value, pp.unit_price * pp.quantity)';

/** Keys removed from supplier_sam / supplier_web inside the statement when a supplier opted out of contact details. */
const SAM_CONTACT_KEYS = [
  'phys_line1', 'phys_line2', 'phys_city', 'phys_state', 'phys_zip', 'phys_zip4', 'phys_country',
  'mail_line1', 'mail_line2', 'mail_city', 'mail_state', 'mail_zip', 'mail_zip4', 'mail_country', 'pocs',
];
const WEB_CONTACT_KEYS = ['phone', 'email', 'contact_url'];
/** The AI profile: everything on supplier_web except the identity of the crawl and the contact keys. */
const WEB_PROFILE_KEYS = ['pages', 'summary', 'products', 'capabilities', 'certifications', 'founded', 'meta_description', 'model', 'error'];
const sqlTextArray = (keys: string[]) => `ARRAY[${keys.map((k) => `'${k}'`).join(', ')}]::text[]`;

/** "Open today": the same rule as the sitemap, the open-demand pages and the solicitation page. */
const OPEN_TODAY_SQL = `s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)`;

/**
 * The whole supplier page in ONE statement (one Hyperdrive round-trip). The
 * headline aggregates are ordinary columns, typed by the driver exactly as the
 * old stand-alone aggregate query returned them; the supplier row, the award
 * list, the class list and every profile section are jsonb sub-selects. The
 * WHERE on the aggregate row makes "no awards" come back as zero rows (the
 * route answers 404) and keeps the sub-selects from running for it.
 *
 * `oo` is the opt-out row: contact keys are deleted from the jsonb here, so
 * an opted-out supplier's address, contacts, phone and email are never read
 * out of the database (hide_contact), and the AI profile fields are dropped
 * (hide_web); with both flags the web row is not returned at all.
 */
const SUPPLIER_PAGE_SQL = `
WITH oo AS (
  SELECT hide_contact, hide_web FROM pub.supplier_optouts WHERE cage = $1
), ident AS (
  SELECT COALESCE(sam.uei, su.uei) AS uei
  FROM pub.suppliers su LEFT JOIN pub.supplier_sam sam ON sam.cage = su.cage
  WHERE su.cage = $1
)
SELECT st.*,
  (SELECT to_jsonb(su) FROM (SELECT name, city, state FROM pub.suppliers WHERE cage = $1) su) AS supplier,
  (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.awarded_on DESC, a.id DESC), '[]'::jsonb)
     FROM (SELECT pp.awarded_on, pp.nsn, n.item_name, pp.quantity, pp.unit_price,
                  ${VALUE_SQL} AS total,
                  pp.agency_id, ag.name AS agency_name, pp.source, pp.source_url, pp.id
           FROM pub.price_points pp
           JOIN pub.nsns n ON n.nsn = pp.nsn
           LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
           WHERE pp.cage = $1
           ORDER BY pp.awarded_on DESC, pp.id DESC
           LIMIT ${SUPPLIER_AWARD_ROWS}) a) AS award_rows,
  (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.awards DESC, c.fsc), '[]'::jsonb)
     FROM (
       -- Link rule per class: price-history page only for deep classes; else the
       -- open-demand page when the class is a 4-digit, non-excluded class that has
       -- any solicitation on record (the same set /open/<fsc>/ is built for).
       SELECT g.fsc, f.name, f.render_depth, g.awards,
              (f.render_depth <> 'excluded' AND g.fsc ~ '^[0-9]{4}$'
               AND EXISTS (SELECT 1 FROM pub.solicitations s WHERE s.fsc = g.fsc)) AS has_open
       FROM (
         SELECT n.fsc, count(*)::int AS awards
         FROM pub.price_points pp
         JOIN pub.nsns n ON n.nsn = pp.nsn
         WHERE pp.cage = $1
         GROUP BY n.fsc
       ) g
       LEFT JOIN pub.fsc f ON f.fsc = g.fsc) c) AS class_rows,
  to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
  (SELECT uei FROM ident) AS uei,
  (SELECT hide_contact FROM oo) AS hide_contact,
  (SELECT hide_web FROM oo) AS hide_web,
  (SELECT CASE WHEN (SELECT hide_contact FROM oo) IS TRUE THEN to_jsonb(x) - ${sqlTextArray(SAM_CONTACT_KEYS)} ELSE to_jsonb(x) END
     FROM pub.supplier_sam x WHERE x.cage = $1) AS sam,
  (SELECT CASE WHEN (SELECT hide_web FROM oo) IS TRUE AND (SELECT hide_contact FROM oo) IS TRUE THEN NULL
               WHEN (SELECT hide_web FROM oo) IS TRUE THEN to_jsonb(w) - ${sqlTextArray(WEB_PROFILE_KEYS)}
               WHEN (SELECT hide_contact FROM oo) IS TRUE THEN to_jsonb(w) - ${sqlTextArray(WEB_CONTACT_KEYS)}
               ELSE to_jsonb(w) END
     FROM pub.supplier_web w WHERE w.cage = $1) AS web,
  (SELECT to_jsonb(x) FROM pub.supplier_stats x WHERE x.cage = $1) AS stats,
  (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.month), '[]'::jsonb)
     FROM (SELECT to_char(pp.awarded_on, 'YYYY-MM') AS month,
                  count(*)::int AS awards,
                  COALESCE(sum(${VALUE_SQL}), 0) AS dollars
           FROM pub.price_points pp
           WHERE pp.cage = $1
             AND pp.awarded_on >= date_trunc('month', CURRENT_DATE)::date - interval '${SUPPLIER_MONTHS - 1} months'
             AND pp.awarded_on < date_trunc('month', CURRENT_DATE)::date + interval '1 month'
           GROUP BY 1) m) AS month_rows,
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.awards DESC, t.last_award DESC, t.nsn), '[]'::jsonb)
     FROM (SELECT pp.nsn, n.item_name, count(*)::int AS awards,
                  COALESCE(sum(${VALUE_SQL}), 0) AS dollars, max(pp.awarded_on) AS last_award
           FROM pub.price_points pp
           JOIN pub.nsns n ON n.nsn = pp.nsn
           WHERE pp.cage = $1
           GROUP BY pp.nsn, n.item_name
           ORDER BY count(*) DESC, max(pp.awarded_on) DESC, pp.nsn
           LIMIT ${SUPPLIER_TOP_NSNS}) t) AS top_nsns,
  (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.awards DESC, g.dollars DESC, g.agency_id), '[]'::jsonb)
     FROM (SELECT pp.agency_id, ag.name AS agency_name, count(*)::int AS awards,
                  COALESCE(sum(${VALUE_SQL}), 0) AS dollars, max(pp.awarded_on) AS last_award
           FROM pub.price_points pp
           JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
           WHERE pp.cage = $1
           GROUP BY pp.agency_id, ag.name
           ORDER BY count(*) DESC, COALESCE(sum(${VALUE_SQL}), 0) DESC, pp.agency_id
           LIMIT ${SUPPLIER_AGENCY_ROWS}) g) AS agency_rows,
  (SELECT jsonb_build_object(
            'count', count(*),
            'total', COALESCE(sum(c.obligation), 0),
            'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.action_date DESC NULLS LAST, r.id DESC)
                               FROM (SELECT ca.id, ca.action_date, ag.name AS agency_name, ca.psc, ca.description,
                                            ca.obligation, ca.piid, ca.source_url
                                     FROM pub.contract_actions ca
                                     LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
                                     WHERE ca.recipient_uei = (SELECT uei FROM ident) AND ca.award_uid NOT LIKE 'DIBBS-%'
                                     ORDER BY ca.action_date DESC NULLS LAST, ca.id DESC
                                     LIMIT ${SUPPLIER_USA_ROWS}) r), '[]'::jsonb))
     FROM pub.contract_actions c
     WHERE c.recipient_uei = (SELECT uei FROM ident) AND c.award_uid NOT LIKE 'DIBBS-%') AS usa,
  (SELECT jsonb_build_object(
            'count', (SELECT count(*) FROM pub.part_numbers pn WHERE pn.cage = $1),
            'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.nsn, r.part_number)
                               FROM (SELECT pn.nsn, n.item_name, pn.part_number
                                     FROM pub.part_numbers pn
                                     JOIN pub.nsns n ON n.nsn = pn.nsn
                                     WHERE pn.cage = $1
                                     ORDER BY pn.nsn, pn.part_number
                                     LIMIT ${SUPPLIER_PART_ROWS}) r), '[]'::jsonb))) AS parts,
  (SELECT jsonb_build_object(
            'total', COALESCE(max(b.total), 0),
            'rows', COALESCE(jsonb_agg(to_jsonb(b) - 'total' ORDER BY b.return_by NULLS LAST, b.sol_number), '[]'::jsonb))
     FROM (SELECT s.sol_number, s.nsn, n.item_name, s.quantity, s.unit_of_issue, s.return_by, s.source, s.source_url,
                  count(*) OVER ()::int AS total
           FROM pub.solicitations s
           LEFT JOIN pub.nsns n ON n.nsn = s.nsn
           WHERE ${OPEN_TODAY_SQL}
             AND s.nsn IN (SELECT pn.nsn FROM pub.part_numbers pn WHERE pn.cage = $1)
           ORDER BY s.return_by NULLS LAST, s.sol_number
           LIMIT ${SUPPLIER_OPEN_ROWS}) b) AS open_bids
FROM (
  SELECT count(*)::int AS awards,
         COALESCE(sum(${VALUE_SQL}), 0) AS dollars,
         count(${VALUE_SQL})::int AS valued,
         count(DISTINCT pp.nsn)::int AS nsns,
         count(DISTINCT n.fsc)::int AS classes,
         min(pp.awarded_on) AS first_award,
         max(pp.awarded_on) AS latest_award,
         max(pp.ingested_at) AS refreshed,
         EXISTS (SELECT 1 FROM pub.part_numbers pn WHERE pn.cage = $1) AS makes_parts
  FROM pub.price_points pp
  JOIN pub.nsns n ON n.nsn = pp.nsn
  WHERE pp.cage = $1
) st
WHERE st.awards > 0`;

/** The 24 calendar months ending with the month of `today` (ISO date), oldest first, zero-filled from the SQL rows. */
export function fillMonths(today: string, rows: JsonRow[], count = SUPPLIER_MONTHS): SupplierMonth[] {
  const byMonth = new Map<string, JsonRow>();
  for (const r of rows) byMonth.set(String(r.month), r);
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: SupplierMonth[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const r = byMonth.get(key);
    out.push({ month: key, awards: r ? num(r.awards) : 0, dollars: r ? num(r.dollars) : 0 });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out.reverse();
}

function mapAddress(r: JsonRow, p: 'phys' | 'mail'): SupplierAddress | null {
  const a: SupplierAddress = {
    line1: clean(r[`${p}_line1`]),
    line2: clean(r[`${p}_line2`]),
    city: clean(r[`${p}_city`]),
    state: clean(r[`${p}_state`]),
    zip: clean(r[`${p}_zip`]),
    zip4: clean(r[`${p}_zip4`]),
    country: clean(r[`${p}_country`]),
  };
  return Object.values(a).some((v) => v !== null) ? a : null;
}

export function mapSam(r: JsonRow | null): SupplierSam | null {
  if (!r) return null;
  return {
    uei: clean(r.uei),
    legalName: clean(r.legal_name),
    dbaName: clean(r.dba_name),
    entityUrl: clean(r.entity_url),
    physical: mapAddress(r, 'phys'),
    mailing: mapAddress(r, 'mail'),
    registrationStatus: clean(r.registration_status),
    registrationDate: isoDateOrNull(r.registration_date),
    expirationDate: isoDateOrNull(r.expiration_date),
    lastUpdateDate: isoDateOrNull(r.last_update_date),
    activationDate: isoDateOrNull(r.activation_date),
    entityStartDate: isoDateOrNull(r.entity_start_date),
    entityStructure: clean(r.entity_structure),
    stateOfIncorporation: clean(r.state_of_incorporation),
    businessTypes: strList(r.business_types),
    sbaCertifications: (Array.isArray(r.sba_certifications) ? r.sba_certifications : []).flatMap((c: JsonRow) => {
      const label = clean(c?.label);
      return label ? [{ label, entry: isoDateOrNull(c.entry), exit: isoDateOrNull(c.exit) }] : [];
    }),
    primaryNaics: clean(r.primary_naics),
    naics: (Array.isArray(r.naics) ? r.naics : []).flatMap((c: JsonRow) => {
      const code = clean(c?.code);
      return code ? [{ code, small: typeof c.small === 'boolean' ? c.small : null }] : [];
    }),
    psc: strList(r.psc),
    pocs: (Array.isArray(r.pocs) ? r.pocs : []).flatMap((c: JsonRow) => {
      const name = clean(c?.name);
      return name ? [{ role: clean(c.role), name, title: clean(c.title) }] : [];
    }),
    sourceFile: clean(r.source_file),
    syncedAt: clean(r.synced_at),
  };
}

/** Only http(s) links are ever rendered from third-party data. */
export const safeHttpUrl = (v: unknown): string | null => {
  const t = clean(v);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};

export function mapWeb(r: JsonRow | null): SupplierWeb | null {
  if (!r) return null;
  const url = safeHttpUrl(r.url);
  if (!url) return null;
  const founded = numOrNull(r.founded);
  return {
    url,
    finalUrl: safeHttpUrl(r.final_url),
    status: String(r.status),
    fetchedAt: String(r.fetched_at),
    pages: (Array.isArray(r.pages) ? r.pages : []).flatMap((p: JsonRow) => {
      const u = safeHttpUrl(p?.url);
      return u ? [{ url: u, title: clean(p.title) }] : [];
    }),
    summary: clean(r.summary),
    products: strList(r.products),
    capabilities: strList(r.capabilities),
    certifications: strList(r.certifications),
    founded: founded !== null && founded >= 1700 && founded <= 2100 ? founded : null,
    phone: clean(r.phone),
    email: clean(r.email),
    contactUrl: safeHttpUrl(r.contact_url),
    metaDescription: clean(r.meta_description),
    model: clean(r.model),
  };
}

export function mapStats(r: JsonRow | null): SupplierStats | null {
  if (!r) return null;
  return {
    awardsAll: num(r.awards_all),
    dollarsAll: num(r.dollars_all),
    awards12m: num(r.awards_12m),
    dollars12m: num(r.dollars_12m),
    awardsPrior12m: num(r.awards_prior_12m),
    dollarsPrior12m: num(r.dollars_prior_12m),
    nsns: num(r.nsns),
    fscs: num(r.fscs),
    agencies: num(r.agencies),
    firstAward: isoDate(r.first_award),
    lastAward: isoDate(r.last_award),
    rankDollars12m: numOrNull(r.rank_dollars_12m),
    rankDollarsAll: numOrNull(r.rank_dollars_all),
    rankWins12m: numOrNull(r.rank_wins_12m),
    rankWinsAll: numOrNull(r.rank_wins_all),
    rankNsns: numOrNull(r.rank_nsns),
    rankFscs: numOrNull(r.rank_fscs),
    rankRising: numOrNull(r.rank_rising),
    risingDelta: numOrNull(r.rising_delta),
    refreshedAt: String(r.refreshed_at),
  };
}

/**
 * Loads everything the supplier page renders for one CAGE code, in a single
 * database round-trip. Returns null when the CAGE has no rows in
 * pub.price_points (the route answers 404).
 */
export async function loadSupplierPage(sql: Sql, cage: string): Promise<SupplierPageData | null> {
  if (!/^[A-Z0-9]{5}$/.test(cage)) return null;

  const res = await sql.unsafe(SUPPLIER_PAGE_SQL, [cage]);
  const st = res[0];
  if (!st || Number(st.awards) === 0) return null;

  const sup = st.supplier as JsonRow | null;
  const awardRows = st.award_rows as JsonRow[];
  const classRows = st.class_rows as JsonRow[];
  const rows: SupplierAward[] = awardRows.map((r) => {
    const agencyName = clean(r.agency_name);
    return {
      awardedOn: isoDate(r.awarded_on),
      nsn: r.nsn,
      itemName: clean(r.item_name),
      quantity: r.quantity !== null ? Number(r.quantity) : null,
      unitPrice: Number(r.unit_price),
      total: r.total !== null ? Number(r.total) : null,
      agencyName,
      // Same slug rule as nsn-page.ts / data.ts, so links land on the static /agency/ pages.
      agencySlug: r.agency_id !== null ? slugify(agencyName ?? `agency-${r.agency_id}`) : null,
      source: r.source,
      sourceUrl: assertSourceUrl(r.source_url, `price_points.id=${r.id} cage=${cage}`),
    };
  });

  const usa = st.usa as JsonRow;
  const parts = st.parts as JsonRow;
  const bids = st.open_bids as JsonRow;
  const today = String(st.today);

  return {
    cage,
    name: clean(sup?.name),
    city: clean(sup?.city),
    state: clean(sup?.state),
    awards: Number(st.awards),
    dollars: Number(st.dollars),
    valuedAwards: Number(st.valued),
    nsns: Number(st.nsns),
    classes: Number(st.classes),
    firstAward: isoDate(st.first_award),
    latestAward: isoDate(st.latest_award),
    rows,
    classRows: classRows.map((r) => {
      const name = clean(r.name);
      return {
        fsc: r.fsc,
        name: name === null || name === `FSC ${r.fsc}` ? null : name,
        awards: Number(r.awards),
        link: r.render_depth === 'deep' ? 'fsc' : r.has_open ? 'open' : null,
      };
    }),
    makesParts: st.makes_parts === true,
    refreshedOn: st.refreshed ? new Date(st.refreshed).toISOString().slice(0, 10) : null,
    today,
    uei: clean(st.uei),
    sam: mapSam(st.sam as JsonRow | null),
    web: mapWeb(st.web as JsonRow | null),
    stats: mapStats(st.stats as JsonRow | null),
    optout: { hideContact: st.hide_contact === true, hideWeb: st.hide_web === true },
    months: fillMonths(today, st.month_rows as JsonRow[]),
    topNsns: (st.top_nsns as JsonRow[]).map((r) => ({
      nsn: r.nsn,
      itemName: clean(r.item_name),
      awards: num(r.awards),
      dollars: num(r.dollars),
      lastAward: isoDate(r.last_award),
    })),
    agencyRows: (st.agency_rows as JsonRow[]).map((r) => {
      const name = clean(r.agency_name) ?? `Agency ${r.agency_id}`;
      return { name, slug: slugify(clean(r.agency_name) ?? `agency-${r.agency_id}`), awards: num(r.awards), dollars: num(r.dollars), lastAward: isoDate(r.last_award) };
    }),
    usaspending: {
      count: num(usa.count),
      total: num(usa.total),
      rows: (usa.rows as JsonRow[]).map((r) => ({
        actionDate: isoDateOrNull(r.action_date),
        agencyName: clean(r.agency_name),
        psc: clean(r.psc),
        description: clean(r.description),
        obligation: numOrNull(r.obligation),
        piid: clean(r.piid),
        sourceUrl: assertSourceUrl(r.source_url, `contract_actions.id=${r.id} cage=${cage}`),
      })),
    },
    parts: {
      count: num(parts.count),
      rows: (parts.rows as JsonRow[]).map((r) => ({ nsn: r.nsn, itemName: clean(r.item_name), partNumber: String(r.part_number) })),
    },
    openBids: {
      total: num(bids.total),
      rows: (bids.rows as JsonRow[]).map((r) => ({
        solNumber: r.sol_number,
        nsn: r.nsn,
        itemName: clean(r.item_name),
        quantity: numOrNull(r.quantity),
        unitOfIssue: clean(r.unit_of_issue),
        returnBy: isoDateOrNull(r.return_by),
        source: r.source,
        sourceUrl: assertSourceUrl(r.source_url, `solicitations ${r.sol_number} cage=${cage}`),
      })),
    },
  };
}
