// Security headers for on-demand responses. Cloudflare Pages applies
// public/_headers to static assets only, not to Pages Function responses, so
// the request-time routes (/nsn/*, /api/*) set the same headers here. Keep
// the CSP in sync with public/_headers.
import { defineMiddleware } from 'astro:middleware';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    'img-src \'self\' data: https://www.googletagmanager.com https://*.google-analytics.com; ' +
    "font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; " +
    "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; " +
    "form-action 'self'; upgrade-insecure-requests",
};

export const onRequest = defineMiddleware(async (_ctx, next) => {
  const res = await next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
});
