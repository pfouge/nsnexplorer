// /data/tape.json — the newest open DIBBS product solicitations that carry an
// NSN, for the demand tape under the header (scripts/tape.ts). Prerendered at
// build time like every other page.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return new Response(JSON.stringify(data.viz.tape), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
