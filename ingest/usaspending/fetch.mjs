#!/usr/bin/env node
// ingest/usaspending/fetch.mjs
// Live fetcher for USAspending's spending_by_award search endpoint, run from
// GitHub Actions (US-hosted runners — see docs/architecture.md #3). This
// container is network-blocked, so this file is written strictly to the
// documented API contract and must be verified on the first live Actions
// run.
//
// Endpoint:  POST https://api.usaspending.gov/api/v2/search/spending_by_award/
// Docs:      https://api.usaspending.gov/docs/endpoints
//
// CLI:
//   node fetch.mjs --psc 5331 --days 14 --out file.jsonl
//   node fetch.mjs --psc 5331 --start-date 2026-01-01 --end-date 2026-01-31 --out file.jsonl

import { writeFile } from 'node:fs/promises';

const API_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const PAGE_LIMIT = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

const FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Description',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Start Date',
  'generated_internal_id',
];

const AWARD_TYPE_CODES = ['A', 'B', 'C', 'D'];

function parseArgs(argv) {
  const args = {
    psc: undefined,
    days: undefined,
    startDate: undefined,
    endDate: undefined,
    out: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--psc') args.psc = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--start-date') args.startDate = argv[++i];
    else if (a === '--end-date') args.endDate = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  if (!args.psc) throw new Error('fetch.mjs: --psc is required');
  if (!args.out) throw new Error('fetch.mjs: --out is required');
  if (!args.startDate && !args.days) {
    throw new Error('fetch.mjs: either --days or --start-date/--end-date is required');
  }
  return args;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function resolveDateRange({ days, startDate, endDate }) {
  if (startDate && endDate) return { start_date: startDate, end_date: endDate };
  const end = endDate ? new Date(endDate) : new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start_date: fmtDate(start), end_date: fmtDate(end) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs a single page request with retry on 5xx/429 (exponential backoff).
 */
async function postPage(body) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`usaspending: HTTP ${res.status} on attempt ${attempt}`);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`usaspending: HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    return res.json();
  }
  throw lastErr;
}

/**
 * Fetches every page of spending_by_award results for a single PSC/date
 * range, handling both `hasNext` and `has_next` page_metadata shapes (the
 * API has used both key spellings across versions/endpoints — handle
 * defensively).
 *
 * @param {{ psc: string, startDate: string, endDate: string }} opts
 * @returns {Promise<object[]>} array of raw result records
 */
export async function fetchAllPages({ psc, startDate, endDate }) {
  const results = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const body = {
      filters: {
        time_period: [{ start_date: startDate, end_date: endDate }],
        award_type_codes: AWARD_TYPE_CODES,
        psc_codes: { require: [['Product', psc]] },
      },
      fields: FIELDS,
      page,
      limit: PAGE_LIMIT,
    };

    const json = await postPage(body);
    const pageResults = json.results || [];
    results.push(...pageResults);

    const meta = json.page_metadata || {};
    const hasNext = meta.hasNext ?? meta.has_next ?? false;
    if (!hasNext || pageResults.length === 0) break;
    page += 1;
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { start_date: startDate, end_date: endDate } = resolveDateRange(args);

  console.log(
    `fetch.mjs: psc=${args.psc} start=${startDate} end=${endDate} -> ${args.out}`
  );

  const results = await fetchAllPages({ psc: args.psc, startDate, endDate });

  const lines = results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : '');
  await writeFile(args.out, lines, 'utf8');

  console.log(`fetch.mjs: wrote ${results.length} record(s) to ${args.out}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
