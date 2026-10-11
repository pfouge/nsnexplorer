// GET /api/me — who the visitor is, their lists and how many followed items changed since they
// were last reviewed. Page scripts call it only when the readable nsn_signed_in cookie exists.
// Never cached. See src/lib/server/account-api.ts.
import type { APIRoute } from 'astro';
import type { AccountEnv } from '../../lib/account-config';
import { handleMe } from '../../lib/server/account-api';

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) => handleMe(request, (locals as { runtime?: { env?: AccountEnv } }).runtime?.env);
