// GET /auth/login?return=/path[&signup=1] — send the visitor to WorkOS AuthKit's hosted sign-in
// page (email code, Google, Microsoft or GitHub). A random state value is kept in a short-lived
// cookie and checked in /auth/callback, so nobody can complete a sign-in this browser did not
// start. 404 while ACCOUNTS_ENABLED is false.
import type { APIRoute } from 'astro';
import { ACCOUNTS_ENABLED, STATE_COOKIE, safeReturnPath, setCookie } from '../../lib/account';
import { readConfig, type AccountEnv } from '../../lib/account-config';
import { isConfigured, redirect, workos } from '../../lib/server/session';

export const prerender = false;

const noStore = { 'Cache-Control': 'private, no-store' };

export const GET: APIRoute = async ({ url, locals }) => {
  if (!ACCOUNTS_ENABLED) return new Response('Not found', { status: 404, headers: noStore });
  const c = readConfig((locals as { runtime?: { env?: AccountEnv } }).runtime?.env);
  if (!isConfigured(c)) return new Response('Accounts are not switched on yet.', { status: 503, headers: noStore });
  // Start every sign-in on the canonical host (www -> apex): the state cookie set here must be
  // readable by /auth/callback, which WorkOS sends to the registered address only.
  if (url.origin !== c.siteUrl) return redirect(`${c.siteUrl}${url.pathname}${url.search}`);
  const returnTo = safeReturnPath(url.searchParams.get('return'));
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const state = `${nonce}.${btoa(returnTo).replace(/=+$/, '')}`;
  const authUrl = workos(c).userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId: c.clientId,
    redirectUri: `${c.siteUrl}/auth/callback`,
    state,
    ...(url.searchParams.get('signup') === '1' ? { screenHint: 'sign-up' as const } : {}),
  });
  return redirect(authUrl, [setCookie(STATE_COOKIE, nonce, { maxAge: 600 })]);
};
