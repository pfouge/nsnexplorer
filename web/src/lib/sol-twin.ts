// sol-twin.ts: the ONE place that decides when a DIBBS solicitation and a SAM.gov notice are the same requirement.
//
// DLA posts many requirements twice: on DIBBS (source 'dibbs_rfq', number stored with dashes, SPE4A5-26-T-1234)
// and on SAM.gov (source 'sam_gov', number as SAM prints it, usually SPE4A526T1234). sol_number is the primary
// key, so the two rows only coexist when the spelling differs; SAM rows carry no NSN and no purchase request
// (ingest/sam/map-sam.mjs), so the number is the only structured link there is.
//
// Rule (strictest, chosen over NSN + dates and purchase request, see the report): two rows are twins when
//   1. their numbers are equal after dropping every character that is not a letter or digit and upper-casing,
//   2. that key has the shape of a DLA solicitation number (6 letters/digits, 2 digits, 1 letter, 4 letters/digits),
//   3. exactly two rows in pub.solicitations share the key, and one is DIBBS and the other SAM.gov.
// A key shared by three rows, or by two rows of one source, pairs nothing.
//
// The SQL below is the same rule for Postgres. shared/sol-twin.mjs holds a plain-Node copy (db/freshness.mjs) and
// sol-twin.test.ts fails when the copies drift. Index: db/migrations/0016_solicitation_twin_key.sql.
//
// No imports: node --test loads this file directly, and the on-request loader bundles it for the Workers runtime.

/** Shape of a DLA solicitation number once separators are gone. */
export const SOL_KEY_FORMAT = '^[A-Z0-9]{6}[0-9]{2}[A-Z][A-Z0-9]{4}$';
const SOL_KEY_RE = new RegExp(SOL_KEY_FORMAT);

/** Number without separators, upper-case: the pairing key. */
export function solKey(solNumber: string | null | undefined): string {
  return String(solNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the key looks like a DLA solicitation number (the only numbers we pair). */
export const isPairableKey = (key: string): boolean => SOL_KEY_RE.test(key);

export const DIBBS_SOURCE = 'dibbs_rfq';
export const SAM_SOURCE = 'sam_gov';

export interface TwinRow {
  solNumber: string;
  source: string;
  sourceUrl: string;
}

/**
 * `rowsWithSameKey` is every row whose key equals the key of `self` (self included, at most a handful: the
 * loader asks for LIMIT 5). Returns the twin, or null when the rule above does not hold.
 */
export function pickTwin<T extends TwinRow>(self: { solNumber: string; source: string }, rowsWithSameKey: readonly T[]): T | null {
  if (!isPairableKey(solKey(self.solNumber))) return null;
  if (rowsWithSameKey.length !== 2) return null;
  const other = rowsWithSameKey.find((r) => r.solNumber !== self.solNumber);
  const me = rowsWithSameKey.find((r) => r.solNumber === self.solNumber);
  if (!other || !me) return null;
  if (solKey(other.solNumber) !== solKey(self.solNumber)) return null;
  const sources = new Set([me.source, other.source]);
  if (me.source === other.source || !sources.has(DIBBS_SOURCE) || !sources.has(SAM_SOURCE)) return null;
  return other;
}

/** Display name of a source, as used everywhere on the site. */
export const sourceLabel = (source: string): string => (source === SAM_SOURCE ? 'SAM.gov' : 'DIBBS');

/** The line on a solicitation page: "Also posted on SAM.gov as X" / "Also on DIBBS as X". */
export function twinLine(twinSource: string, twinNumber: string): { prefix: string; label: string } {
  return twinSource === SAM_SOURCE
    ? { prefix: `Also posted on ${sourceLabel(twinSource)} as`, label: twinNumber }
    : { prefix: `Also on ${sourceLabel(twinSource)} as`, label: twinNumber };
}

/** Short mark for open-demand lists, next to the DIBBS row that stands for the pair. */
export const ALSO_ON_SAM_LABEL = 'Also on SAM.gov';

// ------------------------------------------------------------------------------------------------ SQL

/** Postgres expression for the key of `alias.sol_number`; the expression index in migration 0016 matches it exactly. */
export const solKeySql = (alias = 's'): string => `regexp_replace(upper(${alias}.sol_number), '[^A-Z0-9]', '', 'g')`;

/** Open today, as the site means it (a past-dated 'open' row is not open). */
const openNowSql = (a: string): string => `(${a}.status = 'open' AND (${a}.return_by IS NULL OR ${a}.return_by >= CURRENT_DATE))`;

/**
 * CTE `sam_dupes(sam_number, dibbs_number, sam_url, dibbs_url, drop_sam)`: one row per SAM.gov notice that has a DIBBS twin.
 * Built from the (few) SAM rows joined to the DIBBS rows through the key index: no correlated EXISTS on the big table.
 * drop_sam is true when the pair counts once with the DIBBS row standing for it: always, except when the SAM notice is
 * still open and the DIBBS row is not (the requirement would otherwise vanish from the open lists).
 */
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

/** pub.solicitations without the SAM.gov notices that are the twin of a DIBBS row (see drop_sam above): the pair counts once. */
export const SOLS_ONCE_SQL = `(WITH ${SAM_DUPES_CTE}
  SELECT s0.* FROM pub.solicitations s0
  LEFT JOIN sam_dupes x ON x.sam_number = s0.sol_number AND x.drop_sam
  WHERE x.sam_number IS NULL)`;
