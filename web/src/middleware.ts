// Security headers for on-demand responses. Cloudflare Pages applies
// public/_headers to static assets only, not to Pages Function responses, so
// the request-time routes (/nsn/*, /api/*) set the same headers here. Keep
// the CSP in sync with public/_headers.
import { defineMiddleware } from 'astro:middleware';
import { EMBED_CSP, SITE_CSP, isEmbedPath } from './lib/csp';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': SITE_CSP,
};

// /embed/ pages are built to be framed by any site: same policy with
// frame-ancestors *, and no X-Frame-Options (which cannot say "any site").
const EMBED_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(SECURITY_HEADERS).filter(([k]) => k !== 'X-Frame-Options').map(([k, v]) => [k, k === 'Content-Security-Policy' ? EMBED_CSP : v])
);

// Request-time routes that read Postgres through Hyperdrive. Hyperdrive's free
// plan allows 100,000 queries a day and then fails every query until 00:00 UTC
// (what took the site down on 2026-10-10), and a Pages Function response is
// NOT cached by Cloudflare on its own (cf-cache-status DYNAMIC). So these
// responses are put in the colo cache here, and a failed database call
// becomes a 503 with Retry-After instead of a blank 500.
const DB_ROUTE = /^\/(nsn|supplier|solicitation)\/|^\/api\/(lookup|nsn\/|suppliers)/;

const unavailablePage = (): Response =>
  new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>Temporarily unavailable · NSN Explorer</title>' +
      '<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem">' +
      '<h1 style="font-size:1.4rem">This page is temporarily unavailable</h1>' +
      '<p>NSN Explorer could not reach its database just now. Please try again in a few minutes.</p>' +
      '<p><a href="/">Back to NSN Explorer</a></p></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '900' } }
  );

type Runtime = { ctx?: { waitUntil?: (p: Promise<unknown>) => void } };

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const dbRoute = ctx.request.method === 'GET' && DB_ROUTE.test(url.pathname);
  const edge = dbRoute ? (globalThis as { caches?: { default?: Cache } }).caches?.default : undefined;
  const cacheKey = new Request(url.origin + url.pathname + url.search);

  if (edge) {
    const hit = await edge.match(cacheKey).catch(() => undefined);
    if (hit) return new Response(hit.body, hit);
  }

  let res: Response;
  try {
    res = await next();
  } catch {
    res = new Response(null, { status: 500 });
  }
  if (dbRoute && res.status >= 500) {
    if (!res.headers.get('content-type')?.includes('json')) res = unavailablePage();
  }
  const embed = isEmbedPath(new URL(ctx.request.url).pathname);
  if (embed) res.headers.delete('X-Frame-Options');
  for (const [k, v] of Object.entries(embed ? EMBED_HEADERS : SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }

  // Store successful and not-found answers; Cache-Control (s-maxage) sets the lifetime.
  if (edge && (res.status === 200 || res.status === 404) && /s-maxage=/.test(res.headers.get('Cache-Control') ?? '')) {
    const put = edge.put(cacheKey, res.clone()).catch(() => {});
    (ctx.locals as { runtime?: Runtime }).runtime?.ctx?.waitUntil?.(put);
  }
  return res;
});
