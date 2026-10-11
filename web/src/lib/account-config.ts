// Settings for the account routes, in one place. Pure (no WorkOS SDK), so the unit tests read it.
//
// On Cloudflare Pages these arrive as environment variables on the Function
// (Astro.locals.runtime.env): the public ones as plain variables, the two secrets as encrypted
// variables. docs/accounts-setup.md lists where each value comes from. With any of them missing,
// /api/me answers { signedIn: false, available: false } and every other account route answers 503,
// so a half-finished setup shows nothing worse than hidden buttons.

export interface AccountEnv {
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** Tests only: send WorkOS SDK calls to a local fake ("localhost:8701"). */
  WORKOS_API_HOSTNAME?: string;
  SITE_URL?: string;
}

/** Public values (safe to appear in a browser; here they never need to). Empty until set in Pages. */
export const PUBLIC_DEFAULTS = { WORKOS_CLIENT_ID: '', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' } as const;
export const SITE_URL_DEFAULT = 'https://nsnexplorer.com';

export interface AccountConfig {
  clientId: string; apiKey: string; cookiePassword: string;
  supabaseUrl: string; supabaseKey: string; workosHost: string; siteUrl: string;
}

export function readConfig(env: AccountEnv | undefined | null): AccountConfig {
  const e = env ?? {};
  return {
    clientId: e.WORKOS_CLIENT_ID || PUBLIC_DEFAULTS.WORKOS_CLIENT_ID,
    apiKey: e.WORKOS_API_KEY ?? '',
    cookiePassword: e.WORKOS_COOKIE_PASSWORD ?? '',
    supabaseUrl: (e.SUPABASE_URL || PUBLIC_DEFAULTS.SUPABASE_URL).replace(/\/+$/, ''),
    supabaseKey: e.SUPABASE_PUBLISHABLE_KEY || PUBLIC_DEFAULTS.SUPABASE_PUBLISHABLE_KEY,
    workosHost: e.WORKOS_API_HOSTNAME ?? '',
    siteUrl: (e.SITE_URL || SITE_URL_DEFAULT).replace(/\/+$/, ''),
  };
}

/** Everything the routes need is present (the cookie password must be at least 32 characters). */
export function isConfigured(c: AccountConfig): boolean {
  return !!(c.clientId && c.apiKey && c.cookiePassword.length >= 32 && c.supabaseUrl && c.supabaseKey);
}
