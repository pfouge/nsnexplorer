// GET /api/region.json — tells the analytics loader whether this visitor is in
// a region where consent is asked first (EEA, UK, Switzerland). Reads the
// country Cloudflare attaches to the request; nothing is stored or logged.
import type { APIRoute } from 'astro';

export const prerender = false;

const CONSENT_COUNTRIES = new Set([
  // European Union
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // Rest of the EEA, the United Kingdom, Switzerland
  'IS', 'LI', 'NO', 'GB', 'CH',
]);

export function consentRequired(country: string | null | undefined): boolean {
  // No country on the request (local dev, unusual networks): ask.
  if (!country || country === 'XX' || country === 'T1') return true;
  return CONSENT_COUNTRIES.has(country.toUpperCase());
}

export const GET: APIRoute = async (ctx) => {
  const cf = (ctx.locals as { runtime?: { cf?: { country?: string } } }).runtime?.cf;
  const country = cf?.country ?? ctx.request.headers.get('cf-ipcountry');
  return new Response(JSON.stringify({ consent: consentRequired(country) }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};
