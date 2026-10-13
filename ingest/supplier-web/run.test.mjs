// node:test suite for run.mjs: candidate selection and the end-to-end write path (fixture web + mock AI).
// Needs a migrated scratch database, so it only runs when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_supa node --test ingest/supplier-web/run.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { candidateSql, processSite } from './run.mjs';
import { startFixtureSites, startMockAnthropic, virtualFetch } from './fixtures/sites.mjs';
import { HostLimiter } from './crawl.mjs';

test('candidate SQL: opt-outs excluded, never-fetched first, re-queue rules', () => {
  const sql = candidateSql({ withAi: false, byCage: false });
  assert.match(sql, /COALESCE\(o\.hide_web, false\) = false/);
  assert.match(sql, /ORDER BY \(w\.cage IS NULL\) DESC, st\.dollars_all DESC NULLS LAST/);
  assert.match(sql, /interval '180 days'/);
  assert.match(sql, /w\.status IN \('unreachable', 'error'\) AND w\.fetched_at < now\(\) - interval '30 days'/);
  assert.doesNotMatch(sql, /ok_no_ai/);
  assert.match(candidateSql({ withAi: true, byCage: false }), /ok_no_ai/);
  assert.match(candidateSql({ withAi: false, byCage: true }), /sam\.cage = ANY\(\$2::text\[\]\)/);
  assert.match(candidateSql({ withAi: false, byCage: false, retryFailed: true }), /w\.status IN \('unreachable', 'error', 'no_text'\)/);
  assert.doesNotMatch(candidateSql({ withAi: false, byCage: false }), /'no_text'\)/);
});

let web;
let ai;
before(async () => { web = await startFixtureSites(); ai = await startMockAnthropic(); });
after(async () => { await web.close(); await ai.close(); });

const ctx = (withAi = true) => ({
  log: () => {},
  ai: withAi ? { apiKey: 'k', baseUrl: ai.baseUrl, fetchImpl: virtualFetch(web.port), backoffMs: 1 } : null,
  crawl: { fetchImpl: virtualFetch(web.port), allowPrivate: true, limiter: new HostLimiter(5), robotsCache: new Map(), timeoutMs: 150 },
});
const cand = (host, name = 'ACME FASTENERS') => ({ cage: '1A001', entity_url: `http://${host}/`, name });

test('processSite: full profile with contacts and AI summary', async () => {
  const r = await processSite(cand('acme-parts.test'), ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.phone, '(937) 555-0142');
  assert.equal(r.email, 'sales@acme-parts.test');
  assert.equal(r.contact_url, 'http://acme-parts.test/contact-us');
  assert.equal(r.meta_description, 'Family-owned fastener & fitting machine shop in Dayton, Ohio.');
  assert.equal(r.founded, 1987);
  assert.ok(r.pages.length <= 4 && r.pages.every((p) => p.url && 'title' in p));
  assert.equal(r.error, null);
});

test('processSite: without a key the site is still read -> ok_no_ai with contacts and meta description', async () => {
  const r = await processSite(cand('acme-parts.test'), ctx(false));
  assert.equal(r.status, 'ok_no_ai');
  assert.equal(r.model, null);
  assert.equal(r.summary, null);
  assert.equal(r.phone, '(937) 555-0142');
  assert.match(r.meta_description, /Family-owned/);
});

test('processSite: each failure mode lands in its own status and never throws', async () => {
  assert.equal((await processSite(cand('blocked.test'), ctx())).status, 'robots_blocked');
  assert.equal((await processSite(cand('slow.test'), ctx())).status, 'unreachable');
  assert.equal((await processSite(cand('gone.test'), ctx())).status, 'unreachable');
  assert.equal((await processSite(cand('pdf.test'), ctx())).status, 'no_text');
  const thin = await processSite(cand('thin.test'), ctx());
  assert.equal(thin.status, 'no_text');
  assert.equal(thin.phone, '(330) 555-0188'); // contacts are kept even when there is no text to summarise
  assert.equal(thin.meta_description, 'Single page app shell.');
  const bad = await processSite(cand('acme-parts.test', 'BADCO'), ctx());
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /summary is 130 words/);
  assert.equal(bad.phone, '(937) 555-0142'); // contacts survive a rejected summary
  assert.equal(bad.summary, null);
});

test('processSite: obfuscated own-domain email is read, third-party obfuscated address dropped', async () => {
  const r = await processSite(cand('obfus.test'), ctx(false));
  assert.equal(r.email, 'sales@obfus.test');
  assert.equal(r.phone, '(330) 555-0177 x22');
});

test('processSite: a refused API key turns AI off for the rest of the run', async () => {
  const c = ctx();
  const first = await processSite(cand('acme-parts.test', 'NOKEY CO'), c);
  assert.equal(first.status, 'ok_no_ai');
  assert.equal(c.ai, null);
  const second = await processSite(cand('acme-parts.test'), c);
  assert.equal(second.status, 'ok_no_ai');
});

const url = process.env.TEST_DATABASE_URL;
test('runSupplierWeb end to end against the database (needs TEST_DATABASE_URL)', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const { runSupplierWeb } = await import('./run.mjs');
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const cages = ['1A001', '1A002', '1A003', '1A004', '1A005', 'ZZ9Y8'];
  const clean = async () => {
    await pool.query('DELETE FROM pub.supplier_web WHERE cage = ANY($1)', [cages]);
    await pool.query('DELETE FROM pub.supplier_sam WHERE cage = ANY($1)', [cages]);
    await pool.query('DELETE FROM pub.supplier_optouts WHERE cage = ANY($1)', [cages]);
  };
  try {
    await clean();
    const sites = [['1A001', 'acme-parts.test', 'ACME FASTENERS'], ['1A002', 'blocked.test', 'BLOCKED INC'], ['1A003', 'gone.test', 'GONE LLC'],
      ['1A004', 'acme-parts.test', 'BADCO'], ['1A005', 'thin.test', 'THIN CO'], ['ZZ9Y8', 'acme-parts.test', 'OPTED OUT CO']];
    for (const [cage, host, name] of sites) {
      await pool.query(`INSERT INTO pub.supplier_sam (cage, legal_name, entity_url, source_file) VALUES ($1, $2, $3, 'test')`, [cage, name, `http://${host}/`]);
    }
    await pool.query(`INSERT INTO pub.supplier_optouts (cage, hide_contact, hide_web) VALUES ('ZZ9Y8', false, true)`);
    const env = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: ai.baseUrl, SUPPLIER_WEB_MIN_DELAY_MS: '5', SUPPLIER_WEB_ALLOW_PRIVATE: '1', SUPPLIER_WEB_TIMEOUT_MS: '150' };
    const run = (extra = {}) => runSupplierWeb({ pool, log: () => {}, env: { ...env, ...extra }, fetchImpl: virtualFetch(web.port), limit: 50 });

    const r1 = await run();
    assert.equal(r1.candidates, 5); // the opted-out supplier is never a candidate
    assert.deepEqual(r1.counts, { error: 1, no_text: 1, ok: 1, robots_blocked: 1, unreachable: 1 });
    const rows = Object.fromEntries((await pool.query('SELECT * FROM pub.supplier_web WHERE cage = ANY($1)', [cages])).rows.map((r) => [r.cage.trim(), r]));
    assert.equal(rows['1A001'].status, 'ok');
    assert.deepEqual(rows['1A001'].certifications, ['ISO 9001:2015', 'AS9100D', 'ITAR registered']);
    assert.equal(rows['ZZ9Y8'], undefined);

    const r2 = await run();
    assert.equal(r2.candidates, 0); // fresh rows, and the failures are less than 30 days old

    // A run with no AI key stores ok_no_ai; once a key exists, those are picked up again after a day.
    await pool.query(`DELETE FROM pub.supplier_web WHERE cage = '1A001'`);
    const r3 = await run({ ANTHROPIC_API_KEY: '' });
    assert.equal(r3.counts.ok_no_ai, 1);
    assert.equal((await run()).candidates, 0);
    await pool.query(`UPDATE pub.supplier_web SET fetched_at = now() - interval '2 days' WHERE cage = '1A001'`);
    const r4 = await run();
    assert.equal(r4.counts.ok, 1);
    assert.equal((await pool.query(`SELECT model FROM pub.supplier_web WHERE cage = '1A001'`)).rows[0].model, 'claude-haiku-5-5');
  } finally {
    await clean();
    await pool.end();
  }
});
