// Prerendered NSN sitemap files: /sitemap-nsn-1.xml, -2.xml, ... (at most
// 40,000 URLs each). Lists every NSN the on-demand /nsn/ route serves, in the
// exact canonical dashed form the NSN page emits. Listed by sitemap-nsn-index.xml.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../consts';
import { loadNsnSitemapCodes, toDashedNsn } from '../lib/data';
import { chunkNsns } from '../lib/sitemap-nsn';

export const prerender = true;

export async function getStaticPaths() {
  const chunks = chunkNsns(await loadNsnSitemapCodes());
  return chunks.map((codes, i) => ({ params: { n: String(i + 1) }, props: { codes } }));
}

export const GET: APIRoute = ({ props }) => {
  const codes = (props as { codes: string[] }).codes;
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    codes
      .map((c) => `<url><loc>${SITE_URL}/nsn/${toDashedNsn(c)}/</loc><changefreq>weekly</changefreq></url>`)
      .join('\n') +
    '\n</urlset>\n';
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
