// GET /api/bulk.json?ids=<13-digit NSNs and/or 9-digit NIINs, comma separated>
// — the key facts for up to 50 items in ONE SQL statement, for the /lookup/
// bulk tool and for integrations. Rendered on request (Pages Function) and
// edge-cached for an hour. Like every on-request loader it costs one database
// round-trip and never imports data.ts or `pg`.
import type { APIRoute } from 'astro';
import { dbErrorTag, openSql } from '../../lib/nsn-page';
import { databaseUrlFrom } from '../../lib/runtime-env';
import { NSN_WITH_AMSC_SELECT, assertSourceUrl, competitionOf, COMPETITION_BADGE, toDashedNsn, type Competition } from '../../lib/shared';

export const prerender = false;

const BULK_MAX_IDS = 50;

export interface BulkResult {
  nsn: string;
  niin: string;
  fsc: string;
  className: string | null;
  itemName: string | null;
  amc: string | null;
  amsc: string | null;
  competition: Competition;
  competitionLabel: string;
  pricePoints: number;
  lastPrice: { unitPrice: number; awardedOn: string; sourceUrl: string } | null;
  /** Lowest and highest unit price among the (up to) five most recent price points. */
  recentLow: number | null;
  recentHigh: number | null;
  openSolicitations: number;
  /** Earliest return_by among open solicitations (YYYY-MM-DD), or null. */
  earliestReturnBy: string | null;
  openQuantity: number | null;
  url: string;
}

/**
 * One statement. `base` is the shared NSN + latest-AMSC select restricted to
 * the requested NSNs / NIINs (primary-key and niin index, never a table scan);
 * every other column is a LATERAL sub-select keyed on base.nsn. $1 and $2 are
 * Postgres array literals ('{5340…,…}') so the driver needs no array typing.
 */
const BULK_SQL = `
WITH base AS (
  ${NSN_WITH_AMSC_SELECT}
  WHERE n.nsn = ANY($1::char(13)[]) OR n.niin = ANY($2::char(9)[])
)
SELECT b.nsn, b.niin, b.fsc, b.item_name, b.amc, b.amsc,
       f.name AS class_name,
       pc.n AS price_count,
       lp.unit_price AS last_unit_price, lp.awarded_on AS last_awarded_on, lp.source_url AS last_source_url,
       r5.lo AS recent_low, r5.hi AS recent_high,
       so.n AS open_count, so.earliest AS earliest_return_by, so.qty AS open_qty
FROM base b
LEFT JOIN pub.fsc f ON f.fsc = b.fsc
LEFT JOIN LATERAL (SELECT count(*) AS n FROM pub.price_points p WHERE p.nsn = b.nsn) pc ON true
LEFT JOIN LATERAL (
  SELECT p.unit_price, p.awarded_on, p.source_url FROM pub.price_points p
  WHERE p.nsn = b.nsn ORDER BY p.awarded_on DESC, p.id DESC LIMIT 1
) lp ON true
LEFT JOIN LATERAL (
  SELECT min(x.unit_price) AS lo, max(x.unit_price) AS hi
  FROM (SELECT p.unit_price FROM pub.price_points p WHERE p.nsn = b.nsn
        ORDER BY p.awarded_on DESC, p.id DESC LIMIT 5) x
) r5 ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS n, min(s.return_by) AS earliest, sum(s.quantity) AS qty
  FROM pub.solicitations s
  WHERE s.nsn = b.nsn AND s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)
) so ON true
ORDER BY b.nsn`;

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const json = (body: unknown, status: number, cache: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Cache-Control': cache, ...extra } });

const bad = (error: string): Response => json({ ok: false, results: [], notFound: [], error }, 400, 'no-store');

const isoDate = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type Row = Record<string, unknown>;

function mapBulkRow(r: Row): BulkResult {
  const nsn = String(r.nsn);
  const dashed = toDashedNsn(nsn);
  const competition = competitionOf(r.amc as string | null, r.amsc as string | null);
  const lastPrice =
    r.last_unit_price === null || r.last_unit_price === undefined
      ? null
      : {
          unitPrice: Number(r.last_unit_price),
          awardedOn: isoDate(r.last_awarded_on) as string,
          // Site rule: no price without a link to its government record.
          sourceUrl: assertSourceUrl(r.last_source_url, `bulk lookup ${dashed}`),
        };
  return {
    nsn: dashed,
    niin: String(r.niin),
    fsc: String(r.fsc),
    className: (r.class_name as string | null) ?? null,
    itemName: (r.item_name as string | null) ?? null,
    amc: (r.amc as string | null) ?? null,
    amsc: (r.amsc as string | null) ?? null,
    competition,
    competitionLabel: COMPETITION_BADGE[competition],
    pricePoints: Number(r.price_count ?? 0),
    lastPrice,
    recentLow: num(r.recent_low),
    recentHigh: num(r.recent_high),
    openSolicitations: Number(r.open_count ?? 0),
    earliestReturnBy: isoDate(r.earliest_return_by),
    openQuantity: num(r.open_qty),
    url: `/nsn/${dashed}/`,
  };
}

export const GET: APIRoute = async (ctx) => {
  const raw = (ctx.url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return bad('Pass ids=<comma-separated 13-digit NSNs and/or 9-digit NIINs>.');
  if (raw.length > BULK_MAX_IDS) return bad(`At most ${BULK_MAX_IDS} ids per request (got ${raw.length}).`);

  const nsns: string[] = [];
  const niins: string[] = [];
  for (const id of raw) {
    const digits = /^[\d-]+$/.test(id) ? id.replace(/\D/g, '') : '';
    if (digits.length === 13) {
      if (!nsns.includes(digits)) nsns.push(digits);
    } else if (digits.length === 9) {
      if (!niins.includes(digits)) niins.push(digits);
    } else {
      return bad(`"${id.slice(0, 40)}" is not a 13-digit NSN or a 9-digit NIIN.`);
    }
  }

  const databaseUrl = databaseUrlFrom(ctx);
  if (!databaseUrl) return json({ ok: false, results: [], notFound: [], error: 'Lookup is not configured.' }, 503, 'no-store');

  const sql = openSql(databaseUrl);
  try {
    const rows = (await sql.unsafe(BULK_SQL, [`{${nsns.join(',')}}`, `{${niins.join(',')}}`])) as unknown as Row[];
    const results = rows.map(mapBulkRow);
    const foundNsn = new Set(rows.map((r) => String(r.nsn)));
    const foundNiin = new Set(rows.map((r) => String(r.niin)));
    const notFound = [
      ...nsns.filter((n) => !foundNsn.has(n)).map(toDashedNsn),
      ...niins.filter((n) => !foundNiin.has(n)),
    ];
    return json({ ok: true, results, notFound }, 200, 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  } catch (err) {
    const tag = dbErrorTag(err);
    console.error('bulk db error:', tag);
    return json({ error: 'temporarily unavailable' }, 503, 'no-store', tag ? { 'x-nsn-db-error': tag } : {});
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
};
