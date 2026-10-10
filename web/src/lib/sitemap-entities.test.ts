import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITY_SITEMAP_MAX_URLS, chunkPaths, indexXml, needsSplit, urlsetXml } from './sitemap-entities.ts';

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/supplier/${String(i).padStart(5, '0')}/`);

test('one file up to the limit, numbered files above it', () => {
  assert.equal(needsSplit(paths(ENTITY_SITEMAP_MAX_URLS)), false);
  assert.equal(needsSplit(paths(ENTITY_SITEMAP_MAX_URLS + 1)), true);
  const chunks = chunkPaths(paths(ENTITY_SITEMAP_MAX_URLS * 2 + 1));
  assert.deepEqual(chunks.map((c) => c.length), [ENTITY_SITEMAP_MAX_URLS, ENTITY_SITEMAP_MAX_URLS, 1]);
  assert.deepEqual(chunkPaths([]), []);
});

test('urlset and index documents', () => {
  const x = urlsetXml('https://nsnexplorer.com', ['/supplier/1ABC2/', '/solicitation/SPE7M3-26-Q-0421/']);
  assert.ok(x.includes('<loc>https://nsnexplorer.com/supplier/1ABC2/</loc><changefreq>weekly</changefreq>'));
  assert.ok(x.includes('<loc>https://nsnexplorer.com/solicitation/SPE7M3-26-Q-0421/</loc><changefreq>daily</changefreq>'));
  const i = indexXml('https://nsnexplorer.com', 2);
  assert.ok(i.includes('/sitemap-entities-1.xml') && i.includes('/sitemap-entities-2.xml') && !i.includes('-3.xml'));
});
