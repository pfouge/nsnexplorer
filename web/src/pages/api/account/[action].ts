// /api/account/<action> — the watchlist API the site's own scripts call. See
// src/lib/server/account-api.ts for the list of actions. Never cached; POSTs must come from this site.
import type { APIRoute } from 'astro';
import type { AccountEnv } from '../../../lib/account-config';
import { handleAction } from '../../../lib/server/account-api';

export const prerender = false;

const env = (locals: unknown) => (locals as { runtime?: { env?: AccountEnv } }).runtime?.env;
export const GET: APIRoute = ({ params, request, locals }) => handleAction('GET', String(params.action ?? ''), request, env(locals));
export const POST: APIRoute = ({ params, request, locals }) => handleAction('POST', String(params.action ?? ''), request, env(locals));
