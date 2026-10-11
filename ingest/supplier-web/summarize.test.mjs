// node:test suite for summarize.mjs against the mock Anthropic endpoint (fixtures/sites.mjs).
// Run: node --test ingest/supplier-web/summarize.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validateProfile, copiesSource, AuthError, MODEL, TOOL } from './summarize.mjs';
import { startMockAnthropic } from './fixtures/sites.mjs';

let ai;
before(async () => { ai = await startMockAnthropic(); });
after(async () => { await ai.close(); });

const site = (name) => ({ name, pages: [{ url: 'http://acme-parts.test/about-us', title: 'About', text: 'ACME was founded in 1987 by two machinists who wanted to build better hardware for the Air Force. Today about forty people run CNC lathes.' }] });
const cfg = () => ({ apiKey: 'sk-test-key', baseUrl: ai.baseUrl, backoffMs: 1 });

test('valid answer: request carries the documented headers, forced tool, temperature 0, max_tokens 600', async () => {
  const before = ai.calls.length;
  const { profile, model } = await summarize(site('ACME FASTENERS'), cfg());
  const c = ai.calls[before];
  assert.equal(c.headers['x-api-key'], 'sk-test-key');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(c.body.tool_choice, { type: 'tool', name: 'record_profile' });
  assert.equal(c.body.temperature, 0);
  assert.equal(c.body.max_tokens, 600);
  assert.equal(c.body.model, MODEL);
  assert.deepEqual(c.body.tools, [TOOL]);
  assert.match(c.body.messages[0].content, /untrusted/);
  assert.equal(model, MODEL);
  assert.equal(profile.founded, 1987);
  assert.deepEqual(profile.certifications, ['ISO 9001:2015', 'AS9100D', 'ITAR registered']);
  assert.ok(profile.summary.split(/\s+/).length <= 90);
});

test('invalid tool output is rejected, never repaired', async () => {
  await assert.rejects(summarize(site('BADCO'), cfg()), /rejected model output: summary is 130 words/);
  await assert.rejects(summarize(site('OLDCO'), cfg()), /rejected model output: founded year 1066 is out of range/);
  await assert.rejects(summarize(site('COPYCO'), cfg()), /repeats the site text verbatim/);
  await assert.rejects(summarize(site('NOTOOL'), cfg()), /did not call record_profile/);
});

test('overloaded (529) is retried; 401 raises AuthError', async () => {
  const { profile } = await summarize(site('BUSY CO'), cfg());
  assert.equal(profile.founded, 1987);
  await assert.rejects(summarize(site('NOKEY CO'), cfg()), AuthError);
});

test('a 400 that blames temperature is retried once without it', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    n += 1;
    const body = JSON.parse(init.body);
    if ('temperature' in body) return new Response(JSON.stringify({ type: 'error', error: { message: '`temperature` is not supported for this model' } }), { status: 400 });
    return new Response(JSON.stringify({ model: 'm', content: [{ type: 'tool_use', name: 'record_profile', input: { summary: null, products: [], capabilities: [], certifications: [], founded: null } }] }), { status: 200 });
  };
  const { profile } = await summarize(site('X'), { apiKey: 'k', baseUrl: 'http://x', fetchImpl });
  assert.equal(n, 2);
  assert.equal(profile.summary, null);
});

test('validateProfile: types, lengths, years', () => {
  const ok = { summary: 'Short.', products: ['a'], capabilities: [], certifications: [], founded: 2001 };
  assert.deepEqual(validateProfile(ok), { ...ok });
  assert.throws(() => validateProfile({ ...ok, products: Array(9).fill('x') }), /products has 9 items/);
  assert.throws(() => validateProfile({ ...ok, products: [5] }), /non-text/);
  assert.throws(() => validateProfile({ ...ok, capabilities: ['x'.repeat(81)] }), /too long/);
  assert.throws(() => validateProfile({ ...ok, founded: 1987.5 }), /out of range/);
  assert.throws(() => validateProfile({ ...ok, founded: 2101 }), /out of range/);
  assert.throws(() => validateProfile({ ...ok, summary: 42 }), /not text/);
  assert.throws(() => validateProfile(null), /not an object/);
  assert.deepEqual(validateProfile({ summary: null, products: [], capabilities: [], certifications: [], founded: null }).summary, null);
  assert.equal(copiesSource('a b c', 'a b c d e f'), false); // shorter than the window
});
