// SQL for "find a part by name" (/api/names.json and /search/), kept out of the routes so the
// single-statement check (web/scripts/verify-single-query.mjs) runs the same text.
//
// Never import data.ts (or anything that pulls in `pg`) from here.
//
// One statement, one round-trip. It matches the words of the query against
//   (a) pub.nsns.item_name, and
//   (b) pub.inc_colloquial_names.colloquial_name, joined to the NSN through pub.nsn_identification.inc
// using the trigram indexes from migration 0018 (every word becomes item_name ILIKE '%word%').
//
// Ranking (best first):
//   tier 0  the name equals the query, or equals it with the words reversed ("lock washer" = "WASHER,LOCK")
//   tier 1  the name starts with the query (or the reversed query)
//   tier 2  every query word starts a word of the name
//   tier 3  every query word appears somewhere in the name
// then, inside a tier: an NSN with an open solicitation first, then one with an award in the last two years
// (both are cheap existence checks; counts and the last award date are looked up for the page rows only),
// then the shorter name (closest to what was typed), then name and NSN so pages are stable.
// An NSN reached through both its own name and an everyday name is listed once, by its best match; the
// everyday name is returned only when it beat the item name.
//
// Parameters: $1 phrase, $2 reversed phrase, $3..$6 words (null when unused), $7 limit, $8 offset.
// The words are letters and digits only (parseNameQuery), so no LIKE wildcard can reach the pattern.

import type postgres from 'postgres';
import { NAME_PAGE_SIZE, type NameQuery } from './item-search';
import { CEILING_PRICE_POINT_SQL } from './contract-ceiling';

type Sql = ReturnType<typeof postgres>;

const NORM = (col: string) => `btrim(regexp_replace(lower(${col}), '[^a-z0-9]+', ' ', 'g'))`;
const HAS_WORDS = (col: string) =>
  `${col} ILIKE '%' || $3::text || '%'
      AND ($4::text IS NULL OR ${col} ILIKE '%' || $4::text || '%')
      AND ($5::text IS NULL OR ${col} ILIKE '%' || $5::text || '%')
      AND ($6::text IS NULL OR ${col} ILIKE '%' || $6::text || '%')`;
const STARTS_WORDS = (col: string) =>
  `(' ' || ${col}) LIKE '% ' || $3::text || '%'
      AND ($4::text IS NULL OR (' ' || ${col}) LIKE '% ' || $4::text || '%')
      AND ($5::text IS NULL OR (' ' || ${col}) LIKE '% ' || $5::text || '%')
      AND ($6::text IS NULL OR (' ' || ${col}) LIKE '% ' || $6::text || '%')`;

const TIER = (col: string) => `CASE WHEN ${col} = $1::text OR ${col} = $2::text THEN 0
              WHEN starts_with(${col}, $1::text) OR starts_with(${col}, $2::text) THEN 1
              WHEN ${STARTS_WORDS(col)} THEN 2
              ELSE 3 END`;

// Rows stay narrow (NSN, tier, length) until the page is chosen; names, classes and counts are looked up for
// the page rows only. Open-solicitation and recent-award checks run only for tiers up to the one that fills
// the page (`cut`), because rows in later tiers can never appear on it; `total` still counts every match.
export const ITEM_NAME_SEARCH_SQL = `
WITH by_name AS (
  SELECT n.nsn, 0 AS src, NULL::text AS also_called, x.tier, x.nl
  FROM pub.nsns n,
       LATERAL (SELECT length(q.nn) AS nl, ${TIER('q.nn')} AS tier FROM (SELECT ${NORM('n.item_name')} AS nn OFFSET 0) q) x
  WHERE ${HAS_WORDS('n.item_name')}
), alias_inc AS (
  -- the best everyday name per INC first, so an INC with several matching names is expanded to its NSNs once
  SELECT DISTINCT ON (c.inc) c.inc, c.colloquial_name AS also_called, x.tier, x.nl
  FROM pub.inc_colloquial_names c,
       LATERAL (SELECT length(q.nn) AS nl, ${TIER('q.nn')} AS tier FROM (SELECT ${NORM('c.colloquial_name')} AS nn OFFSET 0) q) x
  WHERE ${HAS_WORDS('c.colloquial_name')}
  ORDER BY c.inc, x.tier, x.nl, c.colloquial_name
), by_alias AS (
  SELECT ni.nsn, 1 AS src, a.also_called, a.tier, a.nl
  FROM alias_inc a
  JOIN pub.nsn_identification ni ON ni.inc = a.inc  -- ni.nsn is a foreign key to pub.nsns, so the NSN exists
), best AS MATERIALIZED (
  SELECT DISTINCT ON (u.nsn) u.*
  FROM (SELECT * FROM by_name UNION ALL SELECT * FROM by_alias) u
  ORDER BY u.nsn, u.tier, u.src, u.nl, u.also_called
), by_tier AS (
  SELECT tier, count(*) AS c FROM best GROUP BY tier
), cut AS (
  SELECT COALESCE(min(a.tier) FILTER (WHERE (SELECT sum(b2.c) FROM by_tier b2 WHERE b2.tier <= a.tier) >= $7::bigint + $8::bigint), 3) AS tier
  FROM by_tier a
), ranked AS (
  SELECT b.*,
         EXISTS (SELECT 1 FROM pub.solicitations s
                  WHERE s.nsn = b.nsn AND s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)) AS has_open,
         EXISTS (SELECT 1 FROM pub.price_points pp
                  WHERE pp.nsn = b.nsn AND pp.awarded_on >= CURRENT_DATE - 730 AND NOT ${CEILING_PRICE_POINT_SQL}) AS has_recent
  FROM best b
  WHERE b.tier <= (SELECT tier FROM cut)
), page AS (
  SELECT r.*
  FROM ranked r
  ORDER BY r.tier, r.has_open DESC, r.has_recent DESC, r.nl, r.nsn
  LIMIT $7 OFFSET $8
)
SELECT p.nsn, n.item_name, n.fsc, f.name AS fsc_name, p.also_called, p.tier,
       (SELECT sum(c) FROM by_tier)::int AS total,
       (SELECT count(*) FROM pub.solicitations s
         WHERE s.nsn = p.nsn AND s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE))::int AS open_n,
       (SELECT max(pp.awarded_on) FROM pub.price_points pp
         WHERE pp.nsn = p.nsn AND NOT ${CEILING_PRICE_POINT_SQL}) AS last_award
FROM page p
JOIN pub.nsns n ON n.nsn = p.nsn
LEFT JOIN pub.fsc f ON f.fsc = n.fsc
ORDER BY p.tier, p.has_open DESC, p.has_recent DESC, p.nl, p.nsn`;

export interface NameRow {
  nsn: string;
  item_name: string | null;
  fsc: string;
  fsc_name: string | null;
  also_called: string | null;
  tier: number;
  open_n: number;
  last_award: string | Date | null;
  total: number;
}

/** Rows for a parsed query: always exactly one database round-trip. */
export async function searchItemNames(sql: Sql, q: Extract<NameQuery, { ok: true }>, limit: number = NAME_PAGE_SIZE, offset = 0): Promise<NameRow[]> {
  const rows = await sql.unsafe(ITEM_NAME_SEARCH_SQL, [q.phrase, q.reversed, q.words[0], q.words[1], q.words[2], q.words[3], limit, offset]);
  return rows as unknown as NameRow[];
}
