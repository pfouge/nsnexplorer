import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs after @astrojs/sitemap: drops every URL whose built page carries a noindex robots meta
// (bare group pages, near-empty open-demand pages, search) from sitemap-*.xml, so the sitemap
// never lists a page search engines are told not to index. Pages rendered on request have no
// built file and are left alone (their own sitemap endpoints decide).
const pruneNoindexFromSitemap = () => ({
  name: 'prune-noindex-from-sitemap',
  hooks: {
    'astro:build:done': ({ dir, logger }) => {
      const dist = fileURLToPath(dir);
      let dropped = 0;
      for (const f of fs.readdirSync(dist).filter((n) => /^sitemap-\d+\.xml$/.test(n))) {
        const file = path.join(dist, f);
        const xml = fs.readFileSync(file, 'utf8');
        const out = xml.replace(/<url>.*?<\/url>/gs, (entry) => {
          const loc = entry.match(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/)?.[1];
          if (!loc) return entry;
          const page = path.join(dist, decodeURIComponent(loc), 'index.html');
          if (!fs.existsSync(page)) return entry;
          const head = fs.readFileSync(page, 'utf8').slice(0, 20000);
          if (!/<meta name="robots" content="noindex/.test(head)) return entry;
          dropped++;
          return '';
        });
        if (out !== xml) fs.writeFileSync(file, out);
      }
      logger.info(`sitemap: dropped ${dropped} noindex page(s)`);
    },
  },
});

export default defineConfig({
  site: 'https://nsnexplorer.com',
  // Static by default; routes that declare `prerender = false` (every
  // /nsn/[nsn]/ page, /api/*) run on the Cloudflare Pages Function at
  // request time. Cloudflare Pages caps a deployment at 20,000 files, so the
  // per-NSN catalog cannot be pre-rendered; the hubs and browse pages still are.
  output: 'static',
  adapter: cloudflare({
    // Lets `astro dev` see the Hyperdrive/DATABASE_URL bindings from
    // wrangler.jsonc / .dev.vars, mirroring production.
    platformProxy: { enabled: true },
  }),
  build: {
    format: 'directory',
  },
  integrations: [
    sitemap({
      // Uncoded SAM notices are kept out of the index (the page carries
      // noindex, follow); .md twins are for LLMs, not search results; /embed/
      // pages are iframe content (noindex, canonical to the full page). NSN pages have their own prerendered sitemap files
      // (pages/sitemap-nsn-*.xml.ts), listed in robots.txt.
      filter: (page) => !page.endsWith('/search/') && !page.includes('/services/other/') && !page.includes('/embed/') && !page.includes('/watchlist/') && !page.endsWith('.md'),
      // Freshness + crawl-priority signals on every entry.
      serialize(item) {
        const isOpenDemand = item.url.includes('/open/') || item.url.includes('/solicitation/');
        return {
          ...item,
          lastmod: new Date().toISOString(),
          changefreq: isOpenDemand ? 'daily' : 'weekly',
          priority: item.url === 'https://nsnexplorer.com/' ? 1.0 : isOpenDemand ? 0.8 : 0.7,
        };
      },
    }),
    pruneNoindexFromSitemap(),
  ],
});
