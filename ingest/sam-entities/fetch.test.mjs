// node:test suite for fetch.mjs against a local http server standing in for api.sam.gov.
// Run: node --test ingest/sam-entities/fetch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchExtract } from './fetch.mjs';
import { makeZip } from './fixtures/zip.mjs';

const KEY = 'test-key-123456';
const zip = makeZip({ 'SAM_PUBLIC_MONTHLY_V2_20261004.dat': 'BOF PUBLIC\nEOF PUBLIC\n' });

async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res, hits.length); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/extracts`, hits, close: () => new Promise((r) => server.close(r)) };
}
const out = () => mkdtempSync(path.join(tmpdir(), 'samfetch-'));
const opts = { apiKey: KEY, backoffMs: 1, log: () => {} };

test('downloads the zip with one request, sending the documented query', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="SAM_PUBLIC_MONTHLY_V2_20261004.ZIP"' });
    res.end(zip);
  });
  const r = await fetchExtract({ ...opts, outDir: out(), baseUrl: s.base });
  await s.close();
  assert.equal(r.requests, 1);
  assert.equal(r.fileName, 'SAM_PUBLIC_MONTHLY_V2_20261004.ZIP');
  assert.deepEqual(readFileSync(r.path), zip);
  const q = new URL(s.hits[0], 'http://x').searchParams;
  assert.equal(q.get('fileType'), 'ENTITY');
  assert.equal(q.get('sensitivity'), 'PUBLIC');
  assert.equal(q.get('frequency'), 'MONTHLY');
  assert.equal(q.get('api_key'), KEY);
});

test('retries a 503 and a 429 but never exceeds 3 requests', async () => {
  const s = await serve((req, res, n) => {
    if (n < 3) { res.writeHead(n === 1 ? 503 : 429); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(zip);
  });
  const r = await fetchExtract({ ...opts, outDir: out(), baseUrl: s.base });
  assert.equal(r.requests, 3);
  assert.match(r.fileName, /^SAM_PUBLIC_MONTHLY_V2_\d{8}\.ZIP$/); // no content-disposition: dated fallback name
  await s.close();

  const always = await serve((req, res) => { res.writeHead(503); res.end('down'); });
  await assert.rejects(fetchExtract({ ...opts, outDir: out(), baseUrl: always.base }), /gave up after 3 request/);
  assert.equal(always.hits.length, 3);
  await always.close();
});

test('a 400 fails at once with the API message and without leaking the key', async () => {
  const s = await serve((req, res) => { res.writeHead(400); res.end(`File not found for ${KEY}`); });
  await assert.rejects(
    fetchExtract({ ...opts, outDir: out(), baseUrl: s.base }),
    (err) => /HTTP 400/.test(err.message) && !err.message.includes(KEY) && /File not found/.test(err.message)
  );
  assert.equal(s.hits.length, 1);
  await s.close();
});

test('a JSON answer with a download URL is followed (counts as a request)', async () => {
  const s = await serve((req, res) => {
    if (req.url.startsWith('/file')) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(zip); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ links: { download: `http://${req.headers.host}/file.zip` } }));
  });
  const r = await fetchExtract({ ...opts, outDir: out(), baseUrl: s.base });
  assert.equal(r.requests, 2);
  await s.close();
});

test('a non-zip body is rejected and removed', async () => {
  const s = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); });
  await assert.rejects(fetchExtract({ ...opts, outDir: out(), baseUrl: s.base }), /not a ZIP/);
  await s.close();
});

test('missing key is an error before any request', async () => {
  await assert.rejects(fetchExtract({ apiKey: '', outDir: out(), baseUrl: 'http://127.0.0.1:1/x' }), /SAM_API_KEY/);
});
