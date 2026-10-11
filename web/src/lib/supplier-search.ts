// SQL for /api/suppliers.json, kept out of the route so the single-statement
// check (web/scripts/verify-single-query.mjs) can run the same text.
//
// Never import data.ts (or anything that pulls in `pg`) from here.

import type postgres from 'postgres';
import type { SupplierQuery } from './entity';

type Sql = ReturnType<typeof postgres>;

const BY_CAGE = `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.cage = $1
  GROUP BY s.cage, s.name, s.city, s.state
  LIMIT 8`;

const byName = (param: string) => `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.name ILIKE ${param} ESCAPE '\\'
  GROUP BY s.cage, s.name, s.city, s.state
  ORDER BY awards DESC, s.name, s.cage
  LIMIT 8`;

const BY_NAME = byName('$1');

// An all-letter five-character query may be a CAGE or a name fragment. Looking
// up the CAGE first and the name only when it finds nothing used to cost two
// round-trips; this answers both cases in one statement ($1 = CAGE, $2 = name
// pattern; the name branch only yields rows when the CAGE branch is empty).
const BY_CAGE_THEN_NAME = `
  WITH by_cage AS (${BY_CAGE})
  SELECT * FROM by_cage
  UNION ALL
  SELECT * FROM (${byName('$2')}) by_name
  WHERE NOT EXISTS (SELECT 1 FROM by_cage)`;

/** Supplier search rows for a parsed query: always exactly one database round-trip. */
export async function searchSupplierRows(sql: Sql, query: Exclude<SupplierQuery, { kind: 'none' }>) {
  if (query.kind === 'name') return sql.unsafe(BY_NAME, [query.pattern]);
  if (query.nameFallback) return sql.unsafe(BY_CAGE_THEN_NAME, [query.cage, query.nameFallback]);
  return sql.unsafe(BY_CAGE, [query.cage]);
}
