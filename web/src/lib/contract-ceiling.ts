// contract-ceiling.ts: the ONE place that decides what a DIBBS "contract ceiling" is.
//
// An indefinite-delivery contract (DIBBS award number type D), a basic ordering style
// agreement (G) or a blanket purchase agreement (A) is first awarded as a BASE award.
// Its recorded total is the most the contract may ever be worth (the ceiling), not money
// spent. The real purchases are the later delivery-order rows. P, V, C and M awards with
// no delivery order are real standalone awards and count normally.
//
// Rule: a DIBBS award row is a contract ceiling when the 9th character of its award
// number (piid) is D, G or A AND it has no delivery order. USAspending rows are never
// ceilings. The SQL fragments below are the same rule written for Postgres; the unit test
// and web/scripts/verify-single-query.mjs keep the two in step.
//
// No imports: node --test loads this file directly, and the on-request loaders bundle it
// for the Workers runtime.

/** 9th character of a DIBBS award number that marks a ceiling-bearing base award. */
export const CEILING_TYPE_CHARS = ['D', 'G', 'A'] as const;

/** Short tag shown beside a ceiling row so a supplier reads it as a contract, not an order. */
export const CEILING_LABEL = 'Long-term contract';

/**
 * True for a DIBBS award row that is the base award of a long-term contract.
 * `piid` is the award number, with "/<delivery order>" appended on order rows.
 */
export function isContractCeiling(
  awardUid: string | null | undefined,
  piid: string | null | undefined,
  deliveryOrder: unknown
): boolean {
  if (typeof awardUid !== 'string' || !awardUid.startsWith('DIBBS-')) return false;
  if (typeof piid !== 'string' || piid.length < 9) return false;
  const type = piid.charAt(8).toUpperCase();
  if (!(CEILING_TYPE_CHARS as readonly string[]).includes(type)) return false;
  if (deliveryOrder === null || deliveryOrder === undefined) return true;
  return String(deliveryOrder).trim() === '';
}

/**
 * The same rule for a pub.price_points row. A DIBBS price point's award_ref is
 * awardNumber, or awardNumber-deliveryOrder when there is one, so "no dash" means "no delivery order".
 */
export function isCeilingPricePoint(source: string | null | undefined, awardRef: string | null | undefined): boolean {
  if (source !== 'dibbs_award' || typeof awardRef !== 'string' || awardRef.length < 9) return false;
  if (!(CEILING_TYPE_CHARS as readonly string[]).includes(awardRef.charAt(8).toUpperCase())) return false;
  return !awardRef.includes('-');
}

/** Amount cell text for a ceiling row, given the already formatted dollar figure ("$350,000"). */
export function ceilingAmountText(formattedUsd: string): string {
  return `up to ${formattedUsd} ceiling`;
}

const TYPES_SQL = CEILING_TYPE_CHARS.map((c) => `'${c}'`).join(', ');

/**
 * SQL boolean (never NULL) for pub.contract_actions: "this row is a contract ceiling".
 * `alias` is the table alias in the caller's FROM clause.
 */
export function contractCeilingSql(alias = 'ca'): string {
  return `COALESCE(${alias}.award_uid LIKE 'DIBBS-%' AND upper(substr(${alias}.piid, 9, 1)) IN (${TYPES_SQL})` +
    ` AND NULLIF(btrim(${alias}.raw ->> 'deliveryOrder'), '') IS NULL, false)`;
}

/** The fragment with the usual alias, and its negation (also never NULL). */
export const CONTRACT_CEILING_SQL = contractCeilingSql('ca');
export const NOT_CONTRACT_CEILING_SQL = `NOT ${CONTRACT_CEILING_SQL}`;

/** SQL boolean (never NULL) for pub.price_points: the same rule on award_ref. */
export function ceilingPricePointSql(alias = 'pp'): string {
  return `COALESCE(${alias}.source = 'dibbs_award' AND upper(substr(${alias}.award_ref, 9, 1)) IN (${TYPES_SQL})` +
    ` AND position('-' in ${alias}.award_ref) = 0, false)`;
}
export const CEILING_PRICE_POINT_SQL = ceilingPricePointSql('pp');
export const NOT_CEILING_PRICE_POINT_SQL = `NOT ${CEILING_PRICE_POINT_SQL}`;
