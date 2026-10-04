// GET /api/nsn/{nsn}.json — the same per-NSN record the /nsn/ page renders,
// as JSON, for apps and integrations. Accepts dashed or bare 13-digit NSNs.
// Rendered on request (Pages Function) and edge-cached for an hour.
import type { APIRoute } from 'astro';
import { loadNsnPage, openSql } from '../../../lib/nsn-page';
import { databaseUrlFrom } from '../../../lib/runtime-env';
import { toDashedNsn, undashNsn } from '../../../lib/shared';

export const prerender = false;

const json = (body: unknown, status: number, cache: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });

export const GET: APIRoute = async (ctx) => {
  const nsnCode = undashNsn(ctx.params.nsn ?? '');
  if (!/^\d{13}$/.test(nsnCode)) return json({ ok: false, error: 'NSN must be 13 digits.' }, 400, 'no-store');

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return json({ ok: false, error: 'Database is not configured.' }, 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    const page = await loadNsnPage(sql, nsnCode);
    if (!page) return json({ ok: false, error: 'NSN not found.' }, 404, 'public, s-maxage=300');
    return json(
      { ok: true, ...page, nsn: { ...page.nsn, dashed: toDashedNsn(page.nsn.nsn), url: `/nsn/${toDashedNsn(page.nsn.nsn)}/` } },
      200,
      'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
    );
  } catch {
    return json({ error: 'temporarily unavailable' }, 503, 'no-store');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
