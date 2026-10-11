// POST /auth/logout — end the session here and at WorkOS, then go home. POST only, from this site
// only, so a link or image elsewhere cannot sign anyone out. 404 while ACCOUNTS_ENABLED is false.
import type { APIRoute } from 'astro';
import { ACCOUNTS_ENABLED, sameOrigin } from '../../lib/account';
import { readConfig, type AccountEnv } from '../../lib/account-config';
import { getSession, isConfigured, redirect, signedOutCookies, workos } from '../../lib/server/session';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  if (!ACCOUNTS_ENABLED) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  if (!sameOrigin(request.headers.get('origin'), new URL(request.url).origin)) return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  const c = readConfig((locals as { runtime?: { env?: AccountEnv } }).runtime?.env);
  let to = '/';
  if (isConfigured(c)) {
    const { session } = await getSession(request, c);
    if (session) {
      try { to = workos(c).userManagement.getLogoutUrl({ sessionId: session.sessionId, returnTo: `${c.siteUrl}/` }); } catch { /* local sign-out still happens */ }
    }
  }
  return redirect(to, signedOutCookies());
};
