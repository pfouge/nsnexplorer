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
// Privacy: only the supplier's name and "City, ST" are read. No street
// address column is selected anywhere.

import type postgres from 'postgres';
import { assertSourceUrl, slugify } from './shared';

type Sql = ReturnType<typeof postgres>;

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
}

const isoDate = (v: unknown): string => new Date(v as string).toISOString().slice(0, 10);
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Supplier award value: the recorded total, else unit price x quantity. */
const VALUE_SQL = 'COALESCE(pp.total_value, pp.unit_price * pp.quantity)';

/**
 * Loads everything the supplier page renders for one CAGE code. Returns null
 * when the CAGE has no rows in pub.price_points (the route answers 404).
 */
export async function loadSupplierPage(sql: Sql, cage: string): Promise<SupplierPageData | null> {
  if (!/^[A-Z0-9]{5}$/.test(cage)) return null;

  const statRows = await sql.unsafe(
    `SELECT count(*)::int AS awards,
            COALESCE(sum(${VALUE_SQL}), 0) AS dollars,
            count(${VALUE_SQL})::int AS valued,
            count(DISTINCT pp.nsn)::int AS nsns,
            count(DISTINCT n.fsc)::int AS classes,
            min(pp.awarded_on) AS first_award,
            max(pp.awarded_on) AS latest_award,
            max(pp.ingested_at) AS refreshed
     FROM pub.price_points pp
     JOIN pub.nsns n ON n.nsn = pp.nsn
     WHERE pp.cage = $1`,
    [cage]
  );
  const st = statRows[0];
  if (!st || Number(st.awards) === 0) return null;

  const [supplierRows, awardRows, classRows] = await Promise.all([
    sql.unsafe(`SELECT name, city, state FROM pub.suppliers WHERE cage = $1`, [cage]),
    sql.unsafe(
      `SELECT pp.awarded_on, pp.nsn, n.item_name, pp.quantity, pp.unit_price,
              ${VALUE_SQL} AS total,
              pp.agency_id, ag.name AS agency_name, pp.source, pp.source_url, pp.id
       FROM pub.price_points pp
       JOIN pub.nsns n ON n.nsn = pp.nsn
       LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
       WHERE pp.cage = $1
       ORDER BY pp.awarded_on DESC, pp.id DESC
       LIMIT ${SUPPLIER_AWARD_ROWS}`,
      [cage]
    ),
    sql.unsafe(
      // Link rule per class: price-history page only for deep classes; else the
      // open-demand page when the class is a 4-digit, non-excluded class that has
      // any solicitation on record (the same set /open/<fsc>/ is built for).
      `SELECT g.fsc, f.name, f.render_depth, g.awards,
              (f.render_depth <> 'excluded' AND g.fsc ~ '^[0-9]{4}$'
               AND EXISTS (SELECT 1 FROM pub.solicitations s WHERE s.fsc = g.fsc)) AS has_open
       FROM (
         SELECT n.fsc, count(*)::int AS awards
         FROM pub.price_points pp
         JOIN pub.nsns n ON n.nsn = pp.nsn
         WHERE pp.cage = $1
         GROUP BY n.fsc
       ) g
       LEFT JOIN pub.fsc f ON f.fsc = g.fsc
       ORDER BY g.awards DESC, g.fsc`,
      [cage]
    ),
  ]);

  const sup = supplierRows[0];
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
    refreshedOn: st.refreshed ? new Date(st.refreshed).toISOString().slice(0, 10) : null,
  };
}
