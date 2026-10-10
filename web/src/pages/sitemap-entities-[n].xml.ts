// Numbered entity sitemap files, produced only when the entity pages exceed
// 45,000 URLs (see sitemap-entities.xml.ts, which then indexes them). With
// fewer URLs there are no paths and no files.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';
import { loadEntitySitemapPaths } from '../lib/data';
import { chunkPaths, needsSplit, urlsetXml } from '../lib/sitemap-entities';

export const prerender = true;

export async function getStaticPaths() {
  const paths = await loadEntitySitemapPaths();
  if (!needsSplit(paths)) return [];
  return chunkPaths(paths).map((chunk, i) => ({ params: { n: String(i + 1) }, props: { chunk } }));
}

export const GET: APIRoute = ({ props }) => {
  const chunk = (props as { chunk: string[] }).chunk;
  return new Response(urlsetXml(SITE_URL, chunk), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
