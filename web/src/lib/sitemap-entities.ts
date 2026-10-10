// Shared constants and helpers for the prerendered entity sitemap
// (pages/sitemap-entities.xml.ts and pages/sitemap-entities-[n].xml.ts):
// supplier pages and open-solicitation pages. One file holds up to 45,000 URLs
// (the sitemap protocol allows 50,000); above that, sitemap-entities.xml
// becomes an index of numbered files.
export const ENTITY_SITEMAP_MAX_URLS = 45000;

/** Splits a list into sitemap-sized chunks (no empty chunks). */
export function chunkPaths(paths: string[], size = ENTITY_SITEMAP_MAX_URLS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size));
  return out;
}

/** True when the paths do not fit in one urlset file. */
export const needsSplit = (paths: string[], size = ENTITY_SITEMAP_MAX_URLS): boolean => paths.length > size;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A <urlset> document for site-relative paths. */
export function urlsetXml(site: string, paths: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map((p) => `<url><loc>${esc(site + p)}</loc><changefreq>${p.startsWith('/solicitation/') ? 'daily' : 'weekly'}</changefreq></url>`).join('\n') +
    '\n</urlset>\n'
  );
}

/** A <sitemapindex> document listing `count` numbered files. */
export function indexXml(site: string, count: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    Array.from({ length: count }, (_, i) => `<sitemap><loc>${site}/sitemap-entities-${i + 1}.xml</loc></sitemap>`).join('\n') +
    '\n</sitemapindex>\n'
  );
}
