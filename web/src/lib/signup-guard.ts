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

// ── Cloudflare Turnstile (bot check) ────────────────────────────────────────────────────────
// The rate-limit rule counts per address, so a flood spread over many addresses could still spend
// Hyperdrive queries. Turnstile makes each signup carry a token only a real browser on this site
// can get. The site key is public (it is in the page); the secret is the Pages variable
// TURNSTILE_SECRET_KEY. Without the secret the server skips the check, so a preview or a
// half-finished setup still accepts signups.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAGF2yvznHSQOyshG'; // widget "nsnexplorer signup", 2026-11-17
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const MAX_TOKEN_LENGTH = 2048; // Cloudflare: tokens are at most 2048 characters

type FetchLike = (url: string, init: { method: string; body: URLSearchParams; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Ask Cloudflare whether the token is good. Any doubt (no token, bad answer, no answer) is a no. */
export async function turnstileOk(secret: string, token: unknown, ip: string | null, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: unknown })?.success === true;
  } catch {
    return false;
  }
}
