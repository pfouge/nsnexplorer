// /data/freshness.json — when each data source last landed rows, with the
// age limit and cadence the freshness strip compares it against
// (components/viz/FreshnessStrip.astro + scripts/freshness.ts). Prerendered.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return new Response(JSON.stringify(data.viz.freshness), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
