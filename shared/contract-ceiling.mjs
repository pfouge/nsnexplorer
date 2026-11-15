// shared/contract-ceiling.mjs: the SQL side of the "contract ceiling" rule for plain-Node code
// (db/*.mjs, ingest/**). The rule itself, and its documentation, live in
// web/src/lib/contract-ceiling.ts; web/src/lib/contract-ceiling.test.ts fails when the two
// copies stop producing identical strings, so they cannot drift apart.
//
// A DIBBS award row is a contract ceiling when the 9th character of its award number (piid)
// is D, G or A AND raw.deliveryOrder is null or blank. Its obligation is the contract's maximum
// value, not money spent.

const TYPES_SQL = ["'D'", "'G'", "'A'"].join(', ');

/** SQL boolean (never NULL) for pub.contract_actions rows: "this row is a contract ceiling". */
export function contractCeilingSql(alias = 'ca') {
  return `COALESCE(${alias}.award_uid LIKE 'DIBBS-%' AND upper(substr(${alias}.piid, 9, 1)) IN (${TYPES_SQL})` +
    ` AND NULLIF(btrim(${alias}.raw ->> 'deliveryOrder'), '') IS NULL, false)`;
}
export const CONTRACT_CEILING_SQL = contractCeilingSql('ca');
export const NOT_CONTRACT_CEILING_SQL = `NOT ${CONTRACT_CEILING_SQL}`;

/** SQL boolean (never NULL) for pub.price_points rows: the same rule on source and award_ref. */
export function ceilingPricePointSql(alias = 'pp') {
  return `COALESCE(${alias}.source = 'dibbs_award' AND upper(substr(${alias}.award_ref, 9, 1)) IN (${TYPES_SQL})` +
    ` AND position('-' in ${alias}.award_ref) = 0, false)`;
}
export const CEILING_PRICE_POINT_SQL = ceilingPricePointSql('pp');
export const NOT_CEILING_PRICE_POINT_SQL = `NOT ${CEILING_PRICE_POINT_SQL}`;
