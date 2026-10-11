#!/usr/bin/env node
// After `npm run build`: checks that pages load the site shell script (search dialog,
// menu drawer, tabs). On 2026-10-11 a conditional <script> in BaseLayout made the build
// drop it from every page without any build error. Usage: node web/scripts/verify-shell-script.mjs [dist-dir]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
const pages = ['index.html', 'open/index.html', 'about/index.html', 'catalog/index.html', 'guides/index.html'];
let failed = 0;
for (const page of pages) {
  const file = join(dist, page);
  if (!existsSync(file)) { console.log(`skip ${page} (not built)`); continue; }
  const html = readFileSync(file, 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith('/_astro/'));
  const ok = srcs.some((s) => {
    const js = join(dist, s);
    return existsSync(js) && /site-search/.test(readFileSync(js, 'utf8')) && /showModal/.test(readFileSync(js, 'utf8'));
  });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${page}${ok ? '' : ' — no loaded script contains the search dialog code'}`);
  if (!ok) failed++;
}
if (failed) { console.error(`${failed} page(s) without the shell script`); process.exit(1); }
console.log('shell script present on every checked page');
