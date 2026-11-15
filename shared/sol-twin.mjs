// shared/sol-twin.mjs: the SQL side of the "same requirement on DIBBS and SAM.gov" rule for plain-Node code
// (db/*.mjs). The rule itself, and its documentation, live in web/src/lib/sol-twin.ts;
// web/src/lib/sol-twin.test.ts fails when the two copies stop producing identical strings.

export const SOL_KEY_FORMAT = '^[A-Z0-9]{6}[0-9]{2}[A-Z][A-Z0-9]{4}$';

export const solKeySql = (alias = 's') => `regexp_replace(upper(${alias}.sol_number), '[^A-Z0-9]', '', 'g')`;

const openNowSql = (a) => `(${a}.status = 'open' AND (${a}.return_by IS NULL OR ${a}.return_by >= CURRENT_DATE))`;

export const SAM_DUPES_CTE = `sam_dupes AS (
  SELECT o.sam_number, o.dibbs_number, o.sam_url, o.dibbs_url, o.drop_sam
  FROM (
    SELECT sm.sol_number AS sam_number, d.sol_number AS dibbs_number, sm.source_url AS sam_url, d.source_url AS dibbs_url,
           d.source AS other_source,
           NOT (${openNowSql('sm')} AND NOT ${openNowSql('d')}) AS drop_sam,
           count(*) OVER (PARTITION BY sm.sol_number) AS n_other
    FROM (SELECT s.sol_number, s.status, s.return_by, s.source_url, ${solKeySql('s')} AS k
          FROM pub.solicitations s WHERE s.source = 'sam_gov') sm
    JOIN pub.solicitations d ON ${solKeySql('d')} = sm.k AND d.sol_number <> sm.sol_number
    WHERE sm.k ~ '${SOL_KEY_FORMAT}'
  ) o
  WHERE o.n_other = 1 AND o.other_source = 'dibbs_rfq'
)`;

export const SOLS_ONCE_SQL = `(WITH ${SAM_DUPES_CTE}
  SELECT s0.* FROM pub.solicitations s0
  LEFT JOIN sam_dupes x ON x.sam_number = s0.sol_number AND x.drop_sam
  WHERE x.sam_number IS NULL)`;
