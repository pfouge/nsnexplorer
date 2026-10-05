import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

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
      filter: (page) => !page.includes('/services/other/') && !page.includes('/embed/') && !page.endsWith('.md'),
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
  ],
});
