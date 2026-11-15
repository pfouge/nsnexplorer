// The site's Content-Security-Policy, in one place. public/_headers (static
// assets) repeats the same two strings verbatim; embed.test.ts fails if they drift.
// Embed pages differ from every other page in exactly one directive.
//
// Ad networks (Google AdSense) load scripts, frames, images and beacons from hundreds of
// hosts that change without notice, so an allowlist of origins cannot work: every fetch
// directive accepts any https: origin. What stays closed is the part that matters for
// injection and framing: object-src 'none', base-uri 'self', form-action limited to this
// site and the sign-in provider, frame-ancestors, and upgrade-insecure-requests.
export const SITE_CSP =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; " +
  "style-src 'self' 'unsafe-inline' https:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
  "connect-src 'self' https:; " +
  "frame-src https:; " +
  "media-src 'self' data: blob: https:; " +
  "form-action 'self' https://api.workos.com; upgrade-insecure-requests";

/** /embed/ pages may be framed by any site. */
export const EMBED_CSP = SITE_CSP.replace("frame-ancestors 'none'", 'frame-ancestors *');

export const isEmbedPath = (pathname: string): boolean => pathname.startsWith('/embed/');
