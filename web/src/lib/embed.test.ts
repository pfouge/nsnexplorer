import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { embedDate, embedSnippet, fscEmbedPath, nsnEmbedPath } from './embed.ts';
import { EMBED_CSP, SITE_CSP, isEmbedPath } from './csp.ts';

test('embed URLs follow the documented shapes', () => {
  assert.equal(fscEmbedPath('5340'), '/embed/fsc/5340/demand/');
  assert.equal(nsnEmbedPath('5331-01-123-4567'), '/embed/nsn/5331-01-123-4567/price/');
});

test('snippet has the mockup shape: iframe 640x360, lazy, titled, then a source link', () => {
  const s = embedSnippet({ src: 'https://nsnexplorer.com/embed/fsc/5340/demand/', pageUrl: 'https://nsnexplorer.com/fsc/5340/', title: 'FSC 5340 demand trend, NSN Explorer' });
  assert.equal(
    s,
    '<iframe src="https://nsnexplorer.com/embed/fsc/5340/demand/" width="640" height="360"\n' +
      '        loading="lazy" title="FSC 5340 demand trend, NSN Explorer"></iframe>\n' +
      '<p>Source: <a href="https://nsnexplorer.com/fsc/5340/">NSN Explorer</a></p>'
  );
});

test('snippet escapes quotes and angle brackets in the title (item names come from government data)', () => {
  const s = embedSnippet({ src: 'https://x/e/', pageUrl: 'https://x/p/', title: 'O"RING <&> SEAL' });
  assert.ok(s.includes('title="O&quot;RING &lt;&amp;&gt; SEAL"'));
  assert.ok(!s.includes('<&>'));
});

test('embed date is a UTC "Mon D, YYYY"', () => {
  assert.equal(embedDate(new Date('2026-10-04T23:59:59Z')), 'Oct 4, 2026');
  assert.equal(embedDate(new Date('2027-01-01T00:00:00Z')), 'Jan 1, 2027');
});

test('embed CSP is the site CSP with only frame-ancestors changed', () => {
  assert.ok(SITE_CSP.includes("frame-ancestors 'none'"));
  assert.ok(EMBED_CSP.includes('frame-ancestors *;'));
  assert.equal(EMBED_CSP.replace('frame-ancestors *', "frame-ancestors 'none'"), SITE_CSP);
  assert.ok(isEmbedPath('/embed/nsn/5331-01-123-4567/price/'));
  assert.ok(!isEmbedPath('/nsn/5331-01-123-4567/'));
});

test('public/_headers carries the same two policies, and /embed/* detaches the inherited ones', () => {
  const raw = fs.readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
  const blocks = raw.split(/\n(?=\S)/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean));
  const rule = (path: string) => blocks.find((b) => b[0] === path) ?? assert.fail(`no ${path} rule`);
  assert.ok(rule('/*').includes(`Content-Security-Policy: ${SITE_CSP}`));
  const embed = rule('/embed/*');
  assert.ok(embed.includes('! Content-Security-Policy'));
  assert.ok(embed.includes('! X-Frame-Options'));
  assert.ok(embed.includes(`Content-Security-Policy: ${EMBED_CSP}`));
  assert.ok(!embed.some((l) => l.startsWith('X-Frame-Options:')));
});
