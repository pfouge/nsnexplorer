// The site's Content-Security-Policy, in one place. public/_headers (static
// assets) repeats the same two strings verbatim; csp.test.ts fails if they drift.
// Embed pages differ from every other page in exactly one directive.
export const SITE_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
  "img-src 'self' data: https://www.googletagmanager.com https://*.google-analytics.com; " +
  "font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; " +
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; " +
  "form-action 'self'; upgrade-insecure-requests";

/** /embed/ pages may be framed by any site. */
export const EMBED_CSP = SITE_CSP.replace("frame-ancestors 'none'", 'frame-ancestors *');

export const isEmbedPath = (pathname: string): boolean => pathname.startsWith('/embed/');
