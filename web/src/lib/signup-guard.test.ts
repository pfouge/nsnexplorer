import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, MAX_TOKEN_LENGTH, TURNSTILE_VERIFY_URL, bodySizeOk, fromThisSite, turnstileOk } from './signup-guard.ts';

const URL_ = 'https://nsnexplorer.com/api/signup';
const h = (o: Record<string, string>) => new Headers(o);

test('fromThisSite: Origin decides when present', () => {
  assert.ok(fromThisSite(h({ origin: 'https://nsnexplorer.com' }), URL_));
  assert.ok(!fromThisSite(h({ origin: 'https://evil.example' }), URL_));
  assert.ok(!fromThisSite(h({ origin: 'https://www.nsnexplorer.com' }), URL_));
  assert.ok(!fromThisSite(h({ origin: 'null' }), URL_));
  // a matching Referer does not rescue a foreign Origin
  assert.ok(!fromThisSite(h({ origin: 'https://evil.example', referer: 'https://nsnexplorer.com/' }), URL_));
  // preview deployments post to themselves
  assert.ok(fromThisSite(h({ origin: 'https://abc.nsnexplorer.pages.dev' }), 'https://abc.nsnexplorer.pages.dev/api/signup'));
});

test('fromThisSite: falls back to Sec-Fetch-Site, then Referer', () => {
  assert.ok(fromThisSite(h({ 'sec-fetch-site': 'same-origin' }), URL_));
  assert.ok(!fromThisSite(h({ 'sec-fetch-site': 'cross-site' }), URL_));
  assert.ok(!fromThisSite(h({ 'sec-fetch-site': 'same-site' }), URL_));
  assert.ok(fromThisSite(h({ referer: 'https://nsnexplorer.com/fsc/5330/' }), URL_));
  assert.ok(!fromThisSite(h({ referer: 'https://evil.example/page' }), URL_));
  assert.ok(!fromThisSite(h({ referer: 'not a url' }), URL_));
});

test('fromThisSite: no browser headers at all is refused', () => {
  assert.ok(!fromThisSite(h({}), URL_));
  assert.ok(!fromThisSite(h({ 'content-type': 'application/json' }), URL_));
});

test('bodySizeOk', () => {
  assert.ok(bodySizeOk(h({})));
  assert.ok(bodySizeOk(h({ 'content-length': '120' })));
  assert.ok(bodySizeOk(h({ 'content-length': String(MAX_BODY_BYTES) })));
  assert.ok(!bodySizeOk(h({ 'content-length': String(MAX_BODY_BYTES + 1) })));
  assert.ok(bodySizeOk(h({ 'content-length': 'abc' })));
});

test('turnstileOk: only an explicit success passes', async () => {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const answer = (ok: boolean, json: unknown) => async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url, body: init.body });
    return { ok, json: async () => json };
  };
  assert.equal(await turnstileOk('sec', 'tok', '203.0.113.9', answer(true, { success: true })), true);
  assert.equal(calls[0].url, TURNSTILE_VERIFY_URL);
  assert.equal(calls[0].body.get('secret'), 'sec');
  assert.equal(calls[0].body.get('response'), 'tok');
  assert.equal(calls[0].body.get('remoteip'), '203.0.113.9');
  assert.equal(await turnstileOk('sec', 'tok', null, answer(true, { success: false, 'error-codes': ['invalid-input-response'] })), false);
  assert.equal(calls[1].body.has('remoteip'), false);
  assert.equal(await turnstileOk('sec', 'tok', null, answer(false, { success: true })), false);
  assert.equal(await turnstileOk('sec', 'tok', null, answer(true, { success: 'true' })), false);
  assert.equal(await turnstileOk('sec', 'tok', null, answer(true, null)), false);
  assert.equal(await turnstileOk('sec', 'tok', null, async () => { throw new Error('network'); }), false);
});

test('turnstileOk: a missing or oversized token never reaches Cloudflare', async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, json: async () => ({ success: true }) }; };
  for (const t of [undefined, null, '', 42, 'x'.repeat(MAX_TOKEN_LENGTH + 1)]) assert.equal(await turnstileOk('sec', t, null, f), false);
  assert.equal(called, 0);
});
