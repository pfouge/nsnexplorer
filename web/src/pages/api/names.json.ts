// GET /api/names.json?q=…&offset=…&limit=… finds parts by item name and by the federal catalog's
// "also called" (colloquial) names, for the site search dialog and the /search/ page. The lookup
// endpoint (/api/lookup.json) is unchanged and still handles NSNs, NIINs and part numbers.
// The query is reduced to letters, digits and spaces before it reaches the database, so no LIKE
// wildcard or quote can get through. Runs on the Pages Function; results are edge-cached for an hour.
import type { APIRoute } from 'astro';
import { openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';
import { NAME_PAGE_SIZE, NAME_MAX_ROWS, clampInt, nameQueryProblem, parseNameQuery, type NameSearchResult } from '../../lib/item-search';
import { searchItemNames } from '../../lib/item-search-sql';
import { shapeNameRows } from '../../lib/item-search-result';

export const prerender = false;

const json = (body: NameSearchResult, status: number, cache: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });

const empty = (query: string, error: string): NameSearchResult => ({ ok: false, query, total: 0, offset: 0, results: [], more: false, error });

export const GET: APIRoute = async (ctx) => {
  const raw = ctx.url.searchParams.get('q') ?? '';
  const parsed = parseNameQuery(raw);
  if (!parsed.ok) return json(empty('', nameQueryProblem(parsed.reason)), 400, 'no-store');

  const limit = clampInt(ctx.url.searchParams.get('limit'), NAME_PAGE_SIZE, 1, NAME_PAGE_SIZE);
  const offset = clampInt(ctx.url.searchParams.get('offset'), 0, 0, NAME_MAX_ROWS - limit);
  const query = parsed.phrase;

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return json(empty(query, 'Search is not configured.'), 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    const rows = await searchItemNames(sql, parsed, limit, offset);
    return json(shapeNameRows(query, rows, offset), 200, 'public, max-age=0, s-maxage=3600');
  } catch {
    return json(empty(query, 'temporarily unavailable'), 503, 'no-store');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
