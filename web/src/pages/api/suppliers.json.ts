// GET /api/suppliers.json?q=… — supplier search for the site search dialog.
// A query of exactly five characters A-Z0-9 is a CAGE code and matches exactly;
// anything else (3+ characters) is a case-insensitive name match. Only
// suppliers with at least one indexed award are returned (they are the ones
// that have a /supplier/<CAGE>/ page), at most 8, most awards first.
// Runs on the Pages Function; results are edge-cached for an hour.
import type { APIRoute } from 'astro';
import { openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';
import { parseSupplierQuery } from '../../lib/entity';

export const prerender = false;

export interface SupplierHit {
  cage: string;
  name: string | null;
  city: string | null;
  state: string | null;
  awards: number;
}

export interface SupplierSearchResult {
  ok: boolean;
  suppliers: SupplierHit[];
  error?: string;
}

const json = (body: SupplierSearchResult, status: number, cache: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });

const BY_CAGE = `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.cage = $1
  GROUP BY s.cage, s.name, s.city, s.state
  LIMIT 8`;

const BY_NAME = `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.name ILIKE $1 ESCAPE '\\'
  GROUP BY s.cage, s.name, s.city, s.state
  ORDER BY awards DESC, s.name, s.cage
  LIMIT 8`;

export const GET: APIRoute = async (ctx) => {
  const query = parseSupplierQuery(ctx.url.searchParams.get('q') ?? '');
  if (query.kind === 'none') {
    return json({ ok: false, suppliers: [], error: 'Enter at least 3 characters of a supplier name or a 5-character CAGE code.' }, 400, 'no-store');
  }

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return json({ ok: false, suppliers: [], error: 'Search is not configured.' }, 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    let rows =
      query.kind === 'cage'
        ? await sql.unsafe(BY_CAGE, [query.cage])
        : await sql.unsafe(BY_NAME, [query.pattern]);
    // An all-letter five-character query may be a name fragment rather than a CAGE.
    if (query.kind === 'cage' && rows.length === 0 && query.nameFallback) {
      rows = await sql.unsafe(BY_NAME, [query.nameFallback]);
    }
    const suppliers: SupplierHit[] = rows.map((r) => ({
      cage: String(r.cage),
      name: r.name ?? null,
      city: r.city ?? null,
      state: r.state ?? null,
      awards: Number(r.awards),
    }));
    return json({ ok: true, suppliers }, 200, 'public, max-age=0, s-maxage=3600');
  } catch {
    return json({ ok: false, suppliers: [], error: 'temporarily unavailable' }, 503, 'no-store');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
