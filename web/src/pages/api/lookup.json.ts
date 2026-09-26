// GET /api/lookup.json?q=… — resolves a 13-digit NSN, a 9-digit NIIN, or a
// manufacturer part number to catalog NSNs. Replaces the build-generated
// /search-index.json, which would be several megabytes at full catalog size.
// Runs on the Pages Function; results are edge-cached for an hour.
import type { APIRoute } from 'astro';
import { openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';
import { toDashedNsn } from '../../lib/shared';

export const prerender = false;

export interface LookupResult {
  ok: boolean;
  kind: 'nsn' | 'niin' | 'part_number' | 'invalid';
  /** Dashed NSNs that match, most relevant first (at most 25). */
  matches: string[];
  error?: string;
}

const json = (body: LookupResult, status: number, cache: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' },
  });

export const GET: APIRoute = async (ctx) => {
  const raw = (ctx.url.searchParams.get('q') ?? '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  const isNumericId = /^[\d\s-]+$/.test(raw) && (digits.length === 9 || digits.length === 13);
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!isNumericId && key.length < 3) {
    return json({ ok: false, kind: 'invalid', matches: [], error: 'Enter an NSN (13 digits), a NIIN (9 digits), or a manufacturer part number.' }, 400, 'no-store');
  }

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return json({ ok: false, kind: 'invalid', matches: [], error: 'Lookup is not configured.' }, 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    let rows: { nsn: string }[];
    let kind: LookupResult['kind'];
    if (isNumericId && digits.length === 13) {
      kind = 'nsn';
      rows = await sql.unsafe(`SELECT nsn FROM pub.nsns WHERE nsn = $1`, [digits]);
    } else if (isNumericId) {
      kind = 'niin';
      rows = await sql.unsafe(`SELECT nsn FROM pub.nsns WHERE niin = $1 ORDER BY nsn LIMIT 25`, [digits]);
    } else {
      kind = 'part_number';
      // Part numbers are stored as written by the source; compare on the
      // alphanumeric skeleton so "MS28775-214" and "MS28775 214" both match.
      rows = await sql.unsafe(
        `SELECT DISTINCT nsn FROM pub.part_numbers
          WHERE upper(regexp_replace(part_number, '[^A-Za-z0-9]', '', 'g')) = $1
          ORDER BY nsn LIMIT 25`,
        [key]
      );
    }
    return json({ ok: true, kind, matches: rows.map((r) => toDashedNsn(r.nsn)) }, 200, 'public, max-age=0, s-maxage=3600');
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
