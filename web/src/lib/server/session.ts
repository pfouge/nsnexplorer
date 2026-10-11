// Server-only: sign-in sessions (WorkOS AuthKit) and calls into Supabase as the signed-in
// visitor. Imported only by on-demand routes (`export const prerender = false`), which run in the
// Cloudflare Pages Function; static pages never load this file. It never touches Postgres through
// Hyperdrive: every account call is an HTTPS fetch to Supabase PostgREST.
//
// Settings: src/lib/account-config.ts (read from Astro.locals.runtime.env by each route).

import { WorkOS } from '@workos-inc/node';
import { COOKIE, SIGNED_IN, SESSION_MAX_AGE, clearCookie, readCookie, setCookie } from '../account';
import type { AccountConfig } from '../account-config';
import { isConfigured } from '../account-config';

export { isConfigured };

const clients = new Map<string, WorkOS>();
export function workos(c: AccountConfig): WorkOS {
  const id = `${c.apiKey}|${c.clientId}|${c.workosHost}`;
  let w = clients.get(id);
  if (!w) {
    const host = c.workosHost;
    w = new WorkOS(c.apiKey, {
      clientId: c.clientId,
      ...(host ? { apiHostname: host.replace(/:\d+$/, ''), port: Number(host.split(':')[1]) || undefined, https: false } : {}),
    });
    clients.set(id, w);
  }
  return w;
}

/** The cookies that mark a visitor as signed in: the sealed session, and a flag scripts can read. */
export function sessionCookies(sealed: string): string[] {
  return [setCookie(COOKIE, sealed, { maxAge: SESSION_MAX_AGE }), setCookie(SIGNED_IN, '1', { maxAge: SESSION_MAX_AGE, httpOnly: false })];
}
export const signedOutCookies = (): string[] => [clearCookie(COOKIE), clearCookie(SIGNED_IN, false)];

export interface Session {
  userId: string; email: string | null; sessionId: string; accessToken: string;
}

/**
 * The visitor's session, or null. An expired access token is refreshed once with the refresh
 * token inside the cookie, and the new cookies are returned for the response to set.
 *
 * Only a cookie that cannot be opened at all is cleared here. A refresh that fails leaves the
 * cookies alone: WorkOS refresh tokens are single-use, so when two requests from one page refresh
 * at the same moment, one wins and sets a new cookie and the other fails; clearing cookies on that
 * failure signed people out minutes after they signed in (SpotTheMoney, 2026-10-10). A session
 * that has really ended stays signed out without it, and /auth/logout clears it.
 */
export async function getSession(request: Request, c: AccountConfig): Promise<{ session: Session | null; setCookies: string[] }> {
  const sealed = readCookie(request.headers.get('cookie'), COOKIE);
  if (!sealed || !isConfigured(c)) return { session: null, setCookies: [] };
  try {
    const s = workos(c).userManagement.loadSealedSession({ sessionData: sealed, cookiePassword: c.cookiePassword });
    const auth = await s.authenticate();
    if (auth.authenticated) {
      return { session: { userId: auth.user.id, email: auth.user.email ?? null, sessionId: auth.sessionId, accessToken: auth.accessToken }, setCookies: [] };
    }
    if (auth.reason === 'invalid_session_cookie') return { session: null, setCookies: signedOutCookies() };
    const r = await s.refresh({ cookiePassword: c.cookiePassword });
    if (r.authenticated && r.sealedSession && r.session) {
      const set = sessionCookies(r.sealedSession);
      return { session: { userId: r.user.id, email: r.user.email ?? null, sessionId: r.sessionId, accessToken: r.session.accessToken }, setCookies: set };
    }
    if (!r.authenticated && r.reason === 'invalid_session_cookie') return { session: null, setCookies: signedOutCookies() };
  } catch { /* network or WorkOS error: signed out for this request only */ }
  return { session: null, setCookies: [] };
}

export class DbError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/**
 * Call one of the 0009 database functions through Supabase's REST endpoint. With a token the call
 * runs as that visitor (role `authenticated`, row-level security on); without one, as `anon`,
 * which may only call public_watchlist() and watch_cards().
 */
export async function rpc<T = unknown>(c: AccountConfig, fn: string, args: Record<string, unknown>, accessToken?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: c.supabaseKey,
        // With Supabase's publishable key the apikey header alone means "anon"; the visitor's
        // WorkOS token in Authorization makes the call run as that visitor.
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new DbError('Something went wrong. Please try again.', 502);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = 'Something went wrong. Please try again.';
    try {
      const j = JSON.parse(text) as { code?: string; message?: string };
      // Messages raised on purpose by the 0009 functions (P0001 / P0002) are written for people.
      if ((j.code === 'P0001' || j.code === 'P0002') && j.message) msg = j.message;
      else if (j.code === '28000' || res.status === 401) msg = 'Please sign in again.';
    } catch { /* not JSON */ }
    throw new DbError(msg, res.status === 401 ? 401 : res.status >= 500 ? 502 : 400);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** A JSON response that is never cached and carries any refreshed session cookies. */
export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'private, no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}
