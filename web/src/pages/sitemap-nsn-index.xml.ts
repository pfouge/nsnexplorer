// Sitemap index for the NSN sitemap files. robots.txt lists it as a second
// Sitemap line next to the integration's sitemap-index.xml. Built from the
// same chunking as sitemap-nsn-[n].xml.ts, so it never lists a file that
// does not exist.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';
import { loadNsnSitemapCodes } from '../lib/data';
import { chunkNsns } from '../lib/sitemap-nsn';

export const prerender = true;

export const GET: APIRoute = async () => {
  const chunks = chunkNsns(await loadNsnSitemapCodes());
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    chunks.map((_, i) => `<sitemap><loc>${SITE_URL}/sitemap-nsn-${i + 1}.xml</loc></sitemap>`).join('\n') +
    '\n</sitemapindex>\n';
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
