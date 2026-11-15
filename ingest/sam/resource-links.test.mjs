// node --test ingest/sam/resource-links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanResourceLinks, countResourceLinks, redactLink } from './resource-links.mjs';

const FILE = 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/aaa/download';

test('redactLink: empty and null values stay, real values go, REDACTED is stable', () => {
  assert.equal(redactLink(`${FILE}?api_key=null&token=`), `${FILE}?api_key=null&token=`);
  assert.equal(redactLink(`${FILE}?api_key=SECRET`), `${FILE}?api_key=REDACTED`);
  assert.equal(redactLink(`${FILE}?a=1&API_KEY=SECRET&b=2`), `${FILE}?a=1&API_KEY=REDACTED&b=2`);
  assert.equal(redactLink(`${FILE}?api_key=REDACTED`), `${FILE}?api_key=REDACTED`);
  assert.equal(redactLink(FILE), FILE);
  assert.equal(redactLink(null), null);
});

test('cleanResourceLinks: objects are cleaned in url, link and href', () => {
  const rec = { resourceLinks: [{ url: `${FILE}?token=abc`, name: 'A.pdf' }, { href: `${FILE}b?apikey=k` }, 5, null] };
  const out = cleanResourceLinks(rec);
  assert.deepEqual(out.resourceLinks, [{ url: `${FILE}?token=REDACTED`, name: 'A.pdf' }, { href: `${FILE}b?apikey=REDACTED` }, 5, null]);
  assert.notEqual(out, rec);
});

test('cleanResourceLinks: nothing to clean returns the same record; non-array links too', () => {
  const rec = { resourceLinks: [FILE] };
  assert.equal(cleanResourceLinks(rec), rec);
  for (const v of [null, undefined, 'x', {}]) { const r = { resourceLinks: v }; assert.equal(cleanResourceLinks(r), r); }
  assert.equal(cleanResourceLinks(null), null);
});

test('countResourceLinks', () => {
  assert.equal(countResourceLinks({ resourceLinks: [FILE, FILE] }), 2);
  assert.equal(countResourceLinks({ resourceLinks: null }), 0);
  assert.equal(countResourceLinks(undefined), 0);
});
