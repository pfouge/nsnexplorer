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

export const onRequest = defineMiddleware(async (ctx, next) => {
  const res = await next();
  const embed = isEmbedPath(new URL(ctx.request.url).pathname);
  if (embed) res.headers.delete('X-Frame-Options');
  for (const [k, v] of Object.entries(embed ? EMBED_HEADERS : SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
});
