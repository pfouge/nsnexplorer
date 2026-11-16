// SQL for the agency profile aggregates (see loadAgencyProfiles in data.ts). Plain strings, no imports.
// DIBBS rows carry no agency and are excluded. ONE statement for ALL agencies: the agency rows of
// pub.contract_actions (~1.5M rows, ~900 MB on 2026-11-16) are read once into a narrow MATERIALIZED CTE
// and every summary below is computed from that CTE. It used to be five statements, each a full read of
// the table (80 to 117 s each on production once the table passed 1.4M rows).
//
// The result is one row set; `kind` says which summary a row belongs to and `ord` orders the rows inside
// one agency's summary. Every column keeps the SQL type the five separate statements returned, so the
// rows map to the same JavaScript values.

export const AGENCY_ACTIONS = `FROM pub.contract_actions ca WHERE ca.agency_id IS NOT NULL AND ca.award_uid NOT LIKE 'DIBBS%'`;

/**
 * Reverse of the supplier page's rule (supplier-page.ts: a supplier's USAspending actions are the rows with
 * recipient_uei = COALESCE(supplier_sam.uei, suppliers.uei)). A UEI resolves to a CAGE only when exactly one
 * CAGE with that UEI has a supplier page (a row in pub.price_points). \`src\` is a CTE with a uei column.
 */
const CAGE_BY_UEI_SQL = (src: string) => `SELECT x.uei, min(x.cage) AS cage, count(*) AS n
    FROM (
      SELECT COALESCE(sam.uei, su.uei) AS uei, su.cage::text AS cage
      FROM pub.suppliers su LEFT JOIN pub.supplier_sam sam ON sam.cage = su.cage
      WHERE COALESCE(sam.uei, su.uei) IN (SELECT uei FROM ${src} WHERE uei IS NOT NULL)
        AND su.cage IN (SELECT pp.cage FROM pub.price_points pp WHERE pp.cage IS NOT NULL GROUP BY pp.cage)
    ) x
    GROUP BY x.uei`;

/** Kinds of row returned by AGENCY_PROFILE_SQL. */
export type AgencyProfileRowKind = 'totals' | 'fy' | 'recipients' | 'classes' | 'recent';

/**
 * Columns (NULL where a kind has no such value):
 *   totals     agency_id, name, abbreviation, actions, obligated, recipients, classes, first_date, last_date
 *   fy         agency_id, fy, actions, obligated                       (ord = fy, ascending)
 *   recipients agency_id, name, uei, cage, actions, obligated          (ord = rank, top 15 by dollars)
 *   classes    agency_id, psc, name, actions, obligated                (ord = rank, top 15 by dollars)
 *   recent     agency_id, action_date, recipient_name, psc, obligation, description, piid, source_url, cage
 *                                                                      (ord = rank, newest 25)
 * Ordered by kind (totals, fy, recipients, classes, recent), agency_id, ord.
 */
export const AGENCY_PROFILE_SQL = `
  WITH base AS MATERIALIZED (
    SELECT ca.id, ca.agency_id, ca.action_date, ca.obligation, ca.recipient_uei, ca.recipient_name, ca.psc
    ${AGENCY_ACTIONS}
  ), fys AS (
    SELECT b.agency_id,
           (extract(year FROM b.action_date)::int + CASE WHEN extract(month FROM b.action_date) >= 10 THEN 1 ELSE 0 END) AS fy,
           count(*) AS actions, COALESCE(sum(b.obligation), 0) AS obligated
    FROM base b
    WHERE b.action_date IS NOT NULL
    GROUP BY 1, 2
  ), ragg AS (
    SELECT b.agency_id, COALESCE(b.recipient_uei, b.recipient_name) AS rkey,
           max(b.recipient_name) AS name, max(b.recipient_uei) AS uei,
           count(*) AS actions, COALESCE(sum(b.obligation), 0) AS obligated
    FROM base b
    WHERE COALESCE(b.recipient_uei, b.recipient_name) IS NOT NULL
    GROUP BY b.agency_id, COALESCE(b.recipient_uei, b.recipient_name)
  ), rtop AS (
    SELECT * FROM (
      SELECT ragg.*, row_number() OVER (PARTITION BY agency_id ORDER BY obligated DESC, rkey) AS rn FROM ragg
    ) r WHERE rn <= 15
  ), rcg AS (
    ${CAGE_BY_UEI_SQL('rtop')}
  ), cagg AS (
    SELECT b.agency_id, b.psc::text AS psc, count(*) AS actions, COALESCE(sum(b.obligation), 0) AS obligated
    FROM base b
    WHERE b.psc IS NOT NULL
    GROUP BY b.agency_id, b.psc
  ), totals AS (
    -- count(DISTINCT ...) needs a sort of every row; the distinct recipients and classes of an agency
    -- are exactly its groups in ragg and cagg below (both drop NULL keys, as count(DISTINCT) does).
    SELECT t.agency_id, ag.name, ag.abbreviation, t.actions, t.obligated,
           COALESCE(rc.n, 0) AS recipients, COALESCE(cc.n, 0) AS classes,
           t.first_date, t.last_date
    FROM (
      SELECT b.agency_id, count(*) AS actions, COALESCE(sum(b.obligation), 0) AS obligated,
             min(b.action_date)::text AS first_date, max(b.action_date)::text AS last_date
      FROM base b
      GROUP BY b.agency_id
    ) t
    JOIN pub.agencies ag ON ag.agency_id = t.agency_id
    LEFT JOIN (SELECT agency_id, count(*) AS n FROM ragg GROUP BY agency_id) rc ON rc.agency_id = t.agency_id
    LEFT JOIN (SELECT agency_id, count(*) AS n FROM cagg GROUP BY agency_id) cc ON cc.agency_id = t.agency_id
  ), ctop AS (
    SELECT * FROM (
      SELECT cagg.*, row_number() OVER (PARTITION BY agency_id ORDER BY obligated DESC, psc) AS rn FROM cagg
    ) r WHERE rn <= 15
  ), rec AS (
    -- Rank on the narrow key only, then read the 25 newest rows per agency by primary key.
    SELECT d.*, q.rn FROM (
      SELECT b.id, b.agency_id,
             row_number() OVER (PARTITION BY b.agency_id ORDER BY b.action_date DESC NULLS LAST, b.id DESC) AS rn
      FROM base b
    ) q
    CROSS JOIN LATERAL (
      SELECT ca.agency_id, ca.action_date, ca.recipient_name, ca.recipient_uei AS uei, ca.psc, ca.obligation,
             ca.description, ca.piid, ca.source_url
      FROM pub.contract_actions ca WHERE ca.id = q.id
      OFFSET 0  -- keep it a primary-key lookup per ranked row (no join over the whole table)
    ) d
    WHERE q.rn <= 25
  ), ecg AS (
    ${CAGE_BY_UEI_SQL('rec')}
  )
  SELECT 1 AS k, 'totals' AS kind, agency_id, 0::bigint AS ord, name, abbreviation, actions, obligated, recipients, classes,
         first_date, last_date, NULL::int AS fy, NULL::text AS uei, NULL::text AS cage, NULL::text AS psc,
         NULL::text AS action_date, NULL::text AS recipient_name, NULL::numeric AS obligation,
         NULL::text AS description, NULL::text AS piid, NULL::text AS source_url
  FROM totals
  UNION ALL
  SELECT 2, 'fy', agency_id, fy::bigint, NULL, NULL, actions, obligated, NULL, NULL,
         NULL, NULL, fy, NULL, NULL, NULL,
         NULL, NULL, NULL,
         NULL, NULL, NULL
  FROM fys
  UNION ALL
  SELECT 3, 'recipients', rtop.agency_id, rtop.rn, rtop.name, NULL, rtop.actions, rtop.obligated, NULL, NULL,
         NULL, NULL, NULL, rtop.uei, CASE WHEN rcg.n = 1 THEN rcg.cage END, NULL,
         NULL, NULL, NULL,
         NULL, NULL, NULL
  FROM rtop LEFT JOIN rcg ON rcg.uei = rtop.uei
  UNION ALL
  SELECT 4, 'classes', ctop.agency_id, ctop.rn, f.name, NULL, ctop.actions, ctop.obligated, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, ctop.psc,
         NULL, NULL, NULL,
         NULL, NULL, NULL
  FROM ctop LEFT JOIN pub.fsc f ON f.fsc = ctop.psc
  UNION ALL
  SELECT 5, 'recent', rec.agency_id, rec.rn, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, CASE WHEN ecg.n = 1 THEN ecg.cage END, rec.psc::text,
         rec.action_date::text, rec.recipient_name, rec.obligation,
         rec.description, rec.piid, rec.source_url
  FROM rec
  LEFT JOIN ecg ON ecg.uei = rec.uei
  ORDER BY k, agency_id, ord`;
