// The account API, shared by /api/me and /api/account/<action>. Every action maps to one database
// function (ACTIONS in src/lib/account.ts) run as the signed-in visitor, so row-level security,
// not this file, decides what a request can read or change.
//
//   GET  /api/me                   signed-in state, lists and items, count of changed items
//   GET  /api/account/feed         what changed per item since it was last reviewed
//   POST /api/account/follow       { kind, key, label?, on?, list? }
//   POST /api/account/list         { id?, name?, public?, delete? }   create / rename / share / delete
//   POST /api/account/move         { kind, key, from, to }
//   POST /api/account/note         { list, kind, key, note }
//   POST /api/account/reviewed     { list?, kind?, key? }   one item, a list, or every list
//   POST /api/account/copy         { slug }                 copy a shared list
//   POST /api/account/cards        { items: [{ kind, key, since? }] }   (no sign-in needed)
//   GET  /api/account/public?slug= a shared list as anyone may see it (no sign-in needed)
//   POST /api/account/delete-account
//
// Never cached (Cache-Control: private, no-store). POSTs must come from this site.

import { ACCOUNTS_ENABLED, ACTIONS, isSlug, sameOrigin } from '../account';
import { readConfig, type AccountEnv } from '../account-config';
import { DbError, getSession, isConfigured, json, rpc, signedOutCookies, workos } from './session';

export async function handleMe(request: Request, env: AccountEnv | undefined): Promise<Response> {
  const c = readConfig(env);
  if (!ACCOUNTS_ENABLED || !isConfigured(c)) return json({ signedIn: false, available: false });
  const { session, setCookies } = await getSession(request, c);
  if (!session) return json({ signedIn: false, available: true }, 200, setCookies);
  try {
    const state = await rpc<object>(c, 'my_state', {}, session.accessToken);
    return json({ signedIn: true, available: true, email: session.email, ...state }, 200, setCookies);
  } catch (e) {
    // The database is down or the token was refused: say signed out for now, keep the cookies.
    return json({ signedIn: false, available: true, error: e instanceof DbError ? e.message : 'Something went wrong. Please try again.' }, 200, setCookies);
  }
}

export async function handleAction(method: 'GET' | 'POST', action: string, request: Request, env: AccountEnv | undefined): Promise<Response> {
  if (!ACCOUNTS_ENABLED) return json({ error: 'Not found.' }, 404);
  if (method === 'POST' && !sameOrigin(request.headers.get('origin'), new URL(request.url).origin)) return json({ error: 'Forbidden.' }, 403);
  const c = readConfig(env);
  if (!isConfigured(c)) return json({ error: 'Accounts are not switched on yet.' }, 503);

  if (action === 'public' && method === 'GET') {
    const slug = new URL(request.url).searchParams.get('slug');
    if (!isSlug(slug)) return json({ error: 'Bad link.' }, 400);
    try {
      const list = await rpc(c, 'public_watchlist', { p_slug: slug });
      return list ? json(list) : json({ error: 'That shared watchlist no longer exists.' }, 404);
    } catch { return json({ error: 'Something went wrong. Please try again.' }, 502); }
  }

  const { session, setCookies } = await getSession(request, c);
  const a = ACTIONS[action];
  if (!session && !(a?.anon && a.method === method)) return json({ error: 'Please sign in.' }, 401, setCookies);

  try {
    if (action === 'delete-account' && method === 'POST' && session) {
      await rpc(c, 'account_delete', {}, session.accessToken);
      try { await workos(c).userManagement.deleteUser(session.userId); } catch { /* data is gone either way; the WorkOS user can be removed by hand */ }
      return json({ deleted: true }, 200, signedOutCookies());
    }
    if (!a || a.method !== method) return json({ error: 'Not found.' }, 404, setCookies);
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try { body = (await request.json()) as Record<string, unknown>; } catch { body = {}; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    const args = a.args(body);
    if (typeof args === 'string') return json({ error: args }, 400, setCookies);
    const data = await rpc(c, a.fn, args, session?.accessToken);
    return json(data, 200, setCookies);
  } catch (e) {
    if (e instanceof DbError) return json({ error: e.message }, e.status, setCookies);
    return json({ error: 'Something went wrong. Please try again.' }, 500, setCookies);
  }
}
