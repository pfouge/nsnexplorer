// Checks /api/signup runs before it touches the database. Pure, so the unit tests read it.
//
// The endpoint is public and writes through Hyperdrive, whose free plan stops answering after
// 100,000 queries a day, so junk requests are turned away here first. A Cloudflare rate-limit
// rule on the path handles floods; these checks stop other websites from posting the form
// through a visitor's browser, and stop oversized input.

export const MAX_EMAIL_LENGTH = 254; // RFC 5321 path limit
export const MAX_BODY_BYTES = 4096;  // an email, a hook name and a few class codes

const originOf = (value: string | null): string | null => {
  if (!value) return null;
  try { return new URL(value).origin; } catch { return null; }
};

/**
 * Did this POST come from a page of this site? Browsers send Origin on every POST; where one is
 * missing (older browsers, privacy tools) Sec-Fetch-Site or Referer is used instead. A request
 * with none of the three is not from a browser form and is refused.
 */
export function fromThisSite(headers: Headers, requestUrl: string): boolean {
  const own = originOf(requestUrl);
  if (!own) return false;
  const origin = headers.get('origin');
  if (origin) return originOf(origin) === own;
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const referer = headers.get('referer');
  if (referer) return originOf(referer) === own;
  return false;
}

/** The declared body size is within the limit (a missing or unreadable length passes). */
export function bodySizeOk(headers: Headers): boolean {
  const n = Number(headers.get('content-length'));
  return !Number.isFinite(n) || n <= MAX_BODY_BYTES;
}
