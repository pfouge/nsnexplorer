// Sitemap of the on-demand entity pages: /supplier/<CAGE>/ for every supplier
// with at least one indexed award, and /solicitation/<number>/ for every
// solicitation that is open today. Prerendered at build time. Up to 45,000
// URLs this file is the urlset itself; above that it becomes an index of
// sitemap-entities-1.xml, -2.xml, ... (pages/sitemap-entities-[n].xml.ts).
// robots.txt lists this one URL either way.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';
import { loadEntitySitemapPaths } from '../lib/data';
import { chunkPaths, indexXml, needsSplit, urlsetXml } from '../lib/sitemap-entities';

export const prerender = true;

export const GET: APIRoute = async () => {
  const paths = await loadEntitySitemapPaths();
  const body = needsSplit(paths) ? indexXml(SITE_URL, chunkPaths(paths).length) : urlsetXml(SITE_URL, paths);
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
