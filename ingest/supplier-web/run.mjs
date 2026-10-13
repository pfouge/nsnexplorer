#!/usr/bin/env node
// ingest/supplier-web/run.mjs
// Daily lane: for suppliers whose SAM record lists a website, read the site politely (crawl.mjs),
// pull out the phone / email the company publishes (extract.mjs), have Claude Haiku write a short
// neutral profile in our own words (summarize.mjs), and store the result in pub.supplier_web.
//
// Candidates (LIMIT --limit, default 150): suppliers with supplier_sam.entity_url that are not opted
// out of the web profile, and that are
//   - never fetched, or
//   - fetched more than 180 days ago, or
//   - unreachable / error and fetched more than 30 days ago, or
//   - registered at a different URL than the one we fetched, or
//   - (only when an Anthropic key is present) stored as ok_no_ai more than a day ago, so profiles
//     crawled before the key existed get their AI summary instead of waiting 180 days.
// Order: never fetched first, then by all-time award dollars (supplier_stats), biggest first.
//
// One site's failure never stops the run; the run ends with counts by status and exits 0 unless the
// database is unreachable. Without ANTHROPIC_API_KEY the sites are still crawled and stored with
// status 'ok_no_ai' (contacts + the site's own meta description, model NULL).
//
//   - (with --retry-failed) unreachable / error / no_text, whatever their age: re-read after a crawler fix.
// --cages A,B,C re-reads exactly those suppliers (testing and fixes).
//
// CLI: node run.mjs [--limit 150] [--cages 12345,6789A] [--retry-failed] [--max-minutes 45]
// Env: DATABASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (tests), SUPPLIER_WEB_MIN_DELAY_MS (tests),
//      SUPPLIER_WEB_ALLOW_PRIVATE=1 (tests that crawl 127.0.0.1)

import { getPool, closePool } from '../../shared/db.mjs';
import { crawlSite, HostLimiter, MIN_DELAY_MS } from './crawl.mjs';
import { extractContacts, extractMetaDescription, pageTexts } from './extract.mjs';
import { summarize, AuthError, MODEL } from './summarize.mjs';

export const CONCURRENCY = 6;
const MIN_TEXT_CHARS = 200;

export function candidateSql({ withAi, byCage, retryFailed = false }) {
  return `
SELECT sam.cage, sam.entity_url, COALESCE(NULLIF(sam.dba_name, ''), sam.legal_name, su.name) AS name
FROM pub.supplier_sam sam
JOIN pub.suppliers su ON su.cage = sam.cage
LEFT JOIN pub.supplier_stats st ON st.cage = sam.cage
LEFT JOIN pub.supplier_web w ON w.cage = sam.cage
LEFT JOIN pub.supplier_optouts o ON o.cage = sam.cage
WHERE sam.entity_url IS NOT NULL
  AND COALESCE(o.hide_web, false) = false
  ${byCage ? 'AND sam.cage = ANY($2::text[])' : ''}
  AND (   ${byCage ? 'true -- named CAGEs are always re-read' : 'false'}
       OR w.cage IS NULL
       OR w.fetched_at < now() - interval '180 days'
       OR (w.status IN ('unreachable', 'error') AND w.fetched_at < now() - interval '30 days')
       OR w.url IS DISTINCT FROM sam.entity_url
       ${withAi ? "OR (w.status = 'ok_no_ai' AND w.fetched_at < now() - interval '1 day')" : ''}
       ${retryFailed ? "OR w.status IN ('unreachable', 'error', 'no_text')" : ''})
ORDER BY ${retryFailed ? "(w.status IN ('unreachable', 'error', 'no_text')) DESC NULLS LAST, " : ''}(w.cage IS NULL) DESC, st.dollars_all DESC NULLS LAST, sam.cage
LIMIT $1`;
}

const UPSERT = `
INSERT INTO pub.supplier_web
  (cage, url, final_url, status, fetched_at, pages, summary, products, capabilities, certifications, founded,
   phone, email, contact_url, meta_description, model, error)
VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7::text[], $8::text[], $9::text[], $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (cage) DO UPDATE SET
  url = EXCLUDED.url, final_url = EXCLUDED.final_url, status = EXCLUDED.status, fetched_at = now(),
  pages = EXCLUDED.pages, summary = EXCLUDED.summary, products = EXCLUDED.products,
  capabilities = EXCLUDED.capabilities, certifications = EXCLUDED.certifications, founded = EXCLUDED.founded,
  phone = EXCLUDED.phone, email = EXCLUDED.email, contact_url = EXCLUDED.contact_url,
  meta_description = EXCLUDED.meta_description, model = EXCLUDED.model, error = EXCLUDED.error`;

const hostOf = (u) => {
  try { return new URL(u).hostname; } catch { return null; }
};

/**
 * Crawls and profiles one supplier. Never throws.
 * @returns {Promise<object>} a pub.supplier_web row (without fetched_at)
 */
export async function processSite(cand, ctx) {
  const row = {
    cage: cand.cage, url: cand.entity_url, final_url: null, status: 'error', pages: [], summary: null,
    products: [], capabilities: [], certifications: [], founded: null, phone: null, email: null,
    contact_url: null, meta_description: null, model: null, error: null,
  };
  try {
    const crawl = await crawlSite(cand.entity_url, ctx.crawl);
    row.final_url = crawl.finalUrl;
    if (crawl.status === 'robots_blocked') return { ...row, status: 'robots_blocked' };
    if (crawl.status === 'no_text') return { ...row, status: 'no_text', error: String(crawl.error || 'no readable text').slice(0, 300) };
    if (crawl.status === 'unreachable') return { ...row, status: 'unreachable', error: String(crawl.error || 'unreachable').slice(0, 300) };

    row.pages = crawl.pages.map((p) => ({ url: p.url, title: p.title }));
    const home = crawl.pages[0];
    row.meta_description = extractMetaDescription(home.html);
    const hosts = [hostOf(cand.entity_url), hostOf(crawl.finalUrl)].filter(Boolean);
    const contacts = extractContacts(crawl.pages, hosts);
    row.phone = contacts.phone;
    row.email = contacts.email;
    row.contact_url = contacts.contactUrl;

    const texts = pageTexts(crawl.pages);
    const chars = texts.reduce((n, t) => n + t.text.length, 0);
    if (chars < MIN_TEXT_CHARS) return { ...row, status: 'no_text', error: 'pages carry almost no readable text' };

    if (!ctx.ai) return { ...row, status: 'ok_no_ai' };
    try {
      const { profile, model } = await summarize({ name: cand.name, pages: texts }, ctx.ai);
      const empty = !profile.summary && !profile.products.length && !profile.capabilities.length && !profile.certifications.length;
      if (empty) return { ...row, status: 'no_text', model, error: 'model found nothing usable on the pages' };
      return { ...row, ...profile, status: 'ok', model };
    } catch (err) {
      if (err instanceof AuthError) {
        ctx.ai = null; // stop calling the API for the rest of the run
        ctx.log(`warn: ${err.message}; continuing without AI summaries`);
        return { ...row, status: 'ok_no_ai', error: err.message.slice(0, 300) };
      }
      return { ...row, status: 'error', error: String(err.message).slice(0, 300) };
    }
  } catch (err) {
    return { ...row, status: 'error', error: String(err.message || err).slice(0, 300) };
  }
}

export async function saveRow(pool, r) {
  await pool.query(UPSERT, [
    r.cage, r.url, r.final_url, r.status, JSON.stringify(r.pages), r.summary, r.products, r.capabilities,
    r.certifications, r.founded, r.phone, r.email, r.contact_url, r.meta_description, r.model, r.error,
  ]);
}

/**
 * @param {{ limit?: number, cage?: string, maxMinutes?: number, pool?: import('pg').Pool, log?: (s: string) => void,
 *           env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} o
 * @returns {Promise<{ counts: Record<string, number>, candidates: number, dbErrors: number }>}
 */
export async function runSupplierWeb({ limit = 150, cage, retryFailed = false, maxMinutes = 45, pool = getPool(), log = console.log, env = process.env, fetchImpl } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY || '';
  const withAi = Boolean(apiKey);
  const cages = cage ? String(cage).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) : [];
  const params = cages.length ? [limit, cages] : [limit];
  const { rows } = await pool.query(candidateSql({ withAi, byCage: cages.length > 0, retryFailed }), params); // DB down -> throws -> exit 1
  log(`supplier-web: ${rows.length} candidate(s), limit ${limit}${retryFailed ? ', retrying earlier failures' : ''}, AI ${withAi ? `on (${env.ANTHROPIC_MODEL || MODEL})` : 'off (no ANTHROPIC_API_KEY): contacts and meta description only'}`);

  const ctx = {
    log,
    ai: withAi ? { apiKey, baseUrl: env.ANTHROPIC_BASE_URL, fetchImpl } : null,
    crawl: {
      limiter: new HostLimiter(Number(env.SUPPLIER_WEB_MIN_DELAY_MS) || MIN_DELAY_MS),
      robotsCache: new Map(),
      allowPrivate: env.SUPPLIER_WEB_ALLOW_PRIVATE === '1',
      fetchImpl,
      timeoutMs: Number(env.SUPPLIER_WEB_TIMEOUT_MS) || undefined,
    },
  };

  const counts = {};
  let dbErrors = 0;
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  const queue = [...rows];
  let skippedForTime = 0;

  async function worker() {
    for (;;) {
      const cand = queue.shift();
      if (!cand) return;
      if (Date.now() > deadline) { skippedForTime += 1; continue; }
      const r = await processSite(cand, ctx);
      try {
        await saveRow(pool, r);
        counts[r.status] = (counts[r.status] || 0) + 1;
        log(`  ${String(r.cage).trim()} ${r.status}${r.phone ? ' phone' : ''}${r.email ? ' email' : ''}${r.error ? ` (${r.error.slice(0, 80)})` : ''}`);
      } catch (err) {
        dbErrors += 1;
        log(`warn: could not save ${String(r.cage).trim()}: ${err.code || err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const parts = Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(' ');
  log(`supplier-web: done. ${parts || 'nothing fetched'}${skippedForTime ? ` | ${skippedForTime} left for tomorrow (time budget)` : ''}${dbErrors ? ` | ${dbErrors} save error(s)` : ''}`);
  return { counts, candidates: rows.length, dbErrors };
}

function parseArgs(argv) {
  const a = { limit: 150, cage: undefined, retryFailed: false, maxMinutes: 45 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') a.limit = Number(argv[++i]);
    else if (argv[i] === '--cage' || argv[i] === '--cages') a.cage = argv[++i];
    else if (argv[i] === '--retry-failed') a.retryFailed = true;
    else if (argv[i] === '--max-minutes') a.maxMinutes = Number(argv[++i]);
  }
  if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 5000) throw new Error('run.mjs: --limit must be an integer from 1 to 5000');
  return a;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const out = await runSupplierWeb(args);
    await closePool();
    // exit 0 even when some saves failed, unless nothing at all could be written
    if (out.dbErrors > 0 && Object.keys(out.counts).length === 0) process.exit(1);
  })().catch(async (err) => {
    console.error(err.message || err);
    await closePool().catch(() => {});
    process.exit(1);
  });
}
