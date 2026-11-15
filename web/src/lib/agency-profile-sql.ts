// SQL for the agency profile aggregates (see loadAgencyProfiles in data.ts). Plain strings, no imports.
// DIBBS rows carry no agency and are excluded; every statement is one GROUP BY / window pass over
// pub.contract_actions for ALL agencies (no correlated subqueries; the table has ~540k rows).

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

export const AGENCY_TOTALS_SQL = `
  SELECT t.agency_id, ag.name, ag.abbreviation, t.actions, t.obligated, t.recipients, t.classes, t.first_date, t.last_date
  FROM (
    SELECT ca.agency_id, count(*) AS actions, COALESCE(sum(ca.obligation), 0) AS obligated,
           count(DISTINCT COALESCE(ca.recipient_uei, ca.recipient_name)) AS recipients,
           count(DISTINCT ca.psc) AS classes,
           min(ca.action_date)::text AS first_date, max(ca.action_date)::text AS last_date
    ${AGENCY_ACTIONS}
    GROUP BY ca.agency_id
  ) t
  JOIN pub.agencies ag ON ag.agency_id = t.agency_id`;

export const AGENCY_FY_SQL = `
  SELECT ca.agency_id,
         (extract(year FROM ca.action_date)::int + CASE WHEN extract(month FROM ca.action_date) >= 10 THEN 1 ELSE 0 END) AS fy,
         count(*) AS actions, COALESCE(sum(ca.obligation), 0) AS obligated
  ${AGENCY_ACTIONS} AND ca.action_date IS NOT NULL
  GROUP BY 1, 2
  ORDER BY 1, 2`;

export const AGENCY_RECIPIENTS_SQL = `
  WITH agg AS (
    SELECT ca.agency_id, COALESCE(ca.recipient_uei, ca.recipient_name) AS rkey,
           max(ca.recipient_name) AS name, max(ca.recipient_uei) AS uei,
           count(*) AS actions, COALESCE(sum(ca.obligation), 0) AS obligated
    ${AGENCY_ACTIONS} AND COALESCE(ca.recipient_uei, ca.recipient_name) IS NOT NULL
    GROUP BY ca.agency_id, COALESCE(ca.recipient_uei, ca.recipient_name)
  ), top AS (
    SELECT * FROM (
      SELECT agg.*, row_number() OVER (PARTITION BY agency_id ORDER BY obligated DESC, rkey) AS rn FROM agg
    ) r WHERE rn <= 15
  ), cg AS (
    ${CAGE_BY_UEI_SQL('top')}
  )
  SELECT top.agency_id, top.name, top.uei, top.actions, top.obligated, CASE WHEN cg.n = 1 THEN cg.cage END AS cage
  FROM top LEFT JOIN cg ON cg.uei = top.uei
  ORDER BY top.agency_id, top.rn`;

export const AGENCY_CLASSES_SQL = `
  WITH agg AS (
    SELECT ca.agency_id, ca.psc::text AS psc, count(*) AS actions, COALESCE(sum(ca.obligation), 0) AS obligated
    ${AGENCY_ACTIONS} AND ca.psc IS NOT NULL
    GROUP BY ca.agency_id, ca.psc
  ), top AS (
    SELECT * FROM (
      SELECT agg.*, row_number() OVER (PARTITION BY agency_id ORDER BY obligated DESC, psc) AS rn FROM agg
    ) r WHERE rn <= 15
  )
  SELECT top.agency_id, top.psc, f.name, top.actions, top.obligated
  FROM top LEFT JOIN pub.fsc f ON f.fsc = top.psc
  ORDER BY top.agency_id, top.rn`;

export const AGENCY_RECENT_SQL = `
  WITH r AS (
    SELECT * FROM (
      SELECT ca.id, ca.agency_id, ca.action_date, ca.recipient_name, ca.recipient_uei AS uei, ca.psc, ca.obligation,
             ca.description, ca.piid, ca.source_url,
             row_number() OVER (PARTITION BY ca.agency_id ORDER BY ca.action_date DESC NULLS LAST, ca.id DESC) AS rn
      ${AGENCY_ACTIONS}
    ) q WHERE q.rn <= 25
  ), cg AS (
    ${CAGE_BY_UEI_SQL('r')}
  )
  SELECT r.agency_id, r.action_date::text AS action_date, r.recipient_name, r.psc::text AS psc, r.obligation,
         r.description, r.piid, r.source_url, CASE WHEN cg.n = 1 THEN cg.cage END AS cage
  FROM r LEFT JOIN cg ON cg.uei = r.uei
  ORDER BY r.agency_id, r.rn`;
