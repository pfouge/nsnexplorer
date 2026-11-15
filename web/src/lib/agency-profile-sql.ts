// SQL for the agency profile aggregates (see loadAgencyProfiles in data.ts). Plain strings, no imports.
// DIBBS rows carry no agency and are excluded; every statement is one GROUP BY / window pass over
// pub.contract_actions for ALL agencies (no correlated subqueries; the table has ~540k rows).

export const AGENCY_ACTIONS = `FROM pub.contract_actions ca WHERE ca.agency_id IS NOT NULL AND ca.award_uid NOT LIKE 'DIBBS%'`;

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
    -- a UEI resolves to a CAGE only when exactly one CAGE with that UEI has a supplier page
    -- (a supplier page exists when the CAGE has a row in pub.price_points)
    SELECT sam.uei, min(sam.cage::text) AS cage, count(*) AS n
    FROM pub.supplier_sam sam
    WHERE sam.uei IN (SELECT uei FROM top WHERE uei IS NOT NULL)
      AND sam.cage IN (SELECT pp.cage FROM pub.price_points pp WHERE pp.cage IS NOT NULL GROUP BY pp.cage)
    GROUP BY sam.uei
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
  SELECT r.agency_id, r.action_date::text AS action_date, r.recipient_name, r.psc::text AS psc, r.obligation,
         r.description, r.piid, r.source_url
  FROM (
    SELECT ca.id, ca.agency_id, ca.action_date, ca.recipient_name, ca.psc, ca.obligation, ca.description, ca.piid, ca.source_url,
           row_number() OVER (PARTITION BY ca.agency_id ORDER BY ca.action_date DESC NULLS LAST, ca.id DESC) AS rn
    ${AGENCY_ACTIONS}
  ) r
  WHERE r.rn <= 25
  ORDER BY r.agency_id, r.rn`;
