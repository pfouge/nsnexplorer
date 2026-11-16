// GET /api/region.json — tells the analytics loader whether this visitor is in
// a region where consent is asked first (EEA, UK, Switzerland). Reads the
// country Cloudflare attaches to the request; nothing is stored or logged.
import type { APIRoute } from 'astro';
import { consentRequired } from '../../lib/consent';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const cf = (ctx.locals as { runtime?: { cf?: { country?: string } } }).runtime?.cf;
  const country = cf?.country ?? ctx.request.headers.get('cf-ipcountry');
  return new Response(JSON.stringify({ consent: consentRequired(country) }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};
