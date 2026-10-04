// GET /nsn/{dashed}.md — the NSN page as Markdown for LLMs and agents. Same
// loader, validation and edge-cache policy as /nsn/{dashed}/ and /api/nsn/.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../../consts';
import { nsnMarkdown } from '../../lib/nsn-markdown';
import { loadNsnPage, openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';
import { toDashedNsn, undashNsn } from '../../lib/shared';

export const prerender = false;

const text = (body: string, status: number, cache: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': cache, ...extra } });

export const GET: APIRoute = async (ctx) => {
  const nsnCode = undashNsn(ctx.params.nsn ?? '');
  // Same rule as the HTML page: anything that is not a 13-digit NSN in the catalog is a 404.
  if (!/^\d{13}$/.test(nsnCode)) return text('NSN not found.\n', 404, 'public, s-maxage=300');

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return text('Database is not configured for this environment.\n', 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    const page = await loadNsnPage(sql, nsnCode);
    if (!page) return text('NSN not found.\n', 404, 'public, s-maxage=300');
    return text(nsnMarkdown(page, SITE_URL), 200, 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400', 'text/markdown; charset=utf-8', {
      Link: `<${SITE_URL}/nsn/${toDashedNsn(page.nsn.nsn)}/>; rel="canonical"`,
    });
  } catch {
    return text('Temporarily unavailable.\n', 503, 'no-store');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
