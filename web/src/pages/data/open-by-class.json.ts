// /data/open-by-class.json — open product solicitations per supply class, for the home page's
// capability matcher (scripts/matcher.ts): count, total quantity, next close date and the five that
// close soonest. Prerendered at build time; fetched only after a visitor picks a class.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { openByClass } from '../../lib/open-by-class';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return new Response(JSON.stringify(openByClass(data.openByFsc, 5, data.viz.today)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
