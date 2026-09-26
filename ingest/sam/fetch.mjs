#!/usr/bin/env node
// ingest/sam/fetch.mjs
// SAM.gov Opportunities API (v2) fetcher — pulls all-agency open
// solicitations posted in the last --days days and writes each raw JSON
// page response to --out, unparsed (ingest/sam/map-sam.mjs does the
// per-record mapping, ingest/sam/load.mjs does the write).
//
// API: GET https://api.sam.gov/opportunities/v2/search
//   api_key     - from process.env.SAM_API_KEY (free api.data.gov key)
//   postedFrom / postedTo - MM/DD/YYYY window, today back --days
//   limit       - 1000 (page size; API max)
//   offset      - paginated until totalRecords is consumed
//   ptype       - 'r,o,k' — the common open-solicitation notice types
//                 (RFQ/solicitation/combined synopsis-solicitation)
//
// Response shape: { totalRecords: number, opportunitiesData: [...] }.
// Each page is written whole (not just opportunitiesData) so load.mjs's
// CLI path and any future debugging has the totalRecords/offset context
// too.
//
// Rate limits: a 429 response backs off exponentially (2s, 4s, 8s, 16s)
// and retries, up to 5 attempts total, before giving up on the whole run.
// Any other non-200 response throws immediately with the status code and a
// snippet of the response body.
//
// CLI:
//   node fetch.mjs --days 30 --out dir/   (default --days: 30)
//
// Writes one file per page: dir/sam-page-N.json

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://api.sam.gov/opportunities/v2/search';
const PAGE_LIMIT = 1000;
// SAM rate-limits bursts (429). Pause between pages to stay under it, and if
// we still get throttled after backoff, stop gracefully and load what we have
// (the nightly schedule fills the rest) rather than failing the whole run.
const THROTTLE_MS = 2500;
// Notice types: r/o/k are the common open-solicitation types SAM's search
// covers (RFQ/solicitation/combined synopsis-solicitation) — see the task
// spec this ingester was built against for the exact code list.
const PTYPE = 'r,o,k';
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { days: 30, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error('fetch.mjs: --days must be a positive integer');
  }
  if (!args.out) throw new Error('fetch.mjs: --out is required');
  return args;
}

/** Formats a Date as SAM's MM/DD/YYYY query-value format, in UTC. */
function formatMmDdYyyy(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

/**
 * Fetches one offset/limit page from the SAM Opportunities API. Retries on
 * HTTP 429 with exponential backoff; throws (status code in the message)
 * on any other non-200 response.
 */
async function fetchPage({ apiKey, postedFrom, postedTo, offset }) {
  const url = new URL(BASE_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', postedFrom);
  url.searchParams.set('postedTo', postedTo);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('ptype', PTYPE);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(url);

    if (res.status === 429) {
      await res.text().catch(() => {}); // drain body
      if (attempt === MAX_ATTEMPTS) {
        // Exhausted backoff — signal the caller to stop gracefully and keep
        // whatever pages were already written, instead of failing the run.
        console.error(`fetch.mjs: still rate-limited (429) after ${MAX_ATTEMPTS} attempts at offset ${offset}; stopping early with partial data`);
        return null;
      }
      const wait = 2 ** attempt * 5000; // 5s, 10s, 20s, 40s, 80s
      console.error(`fetch.mjs: 429 at offset ${offset}, attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }

    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new Error(`fetch.mjs: SAM API returned ${res.status} at offset ${offset}: ${body.slice(0, 500)}`);
    }

    return res.json();
  }
  throw new Error('fetch.mjs: unreachable');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SAM_API_KEY;
  if (!apiKey) {
    throw new Error('fetch.mjs: SAM_API_KEY is required');
  }

  await mkdir(args.out, { recursive: true });

  const now = new Date();
  const from = new Date(now.getTime() - args.days * 86400000);
  const postedFrom = formatMmDdYyyy(from);
  const postedTo = formatMmDdYyyy(now);

  console.log(`fetch.mjs: fetching SAM opportunities postedFrom=${postedFrom} postedTo=${postedTo} ptype=${PTYPE}`);

  let offset = 0;
  let totalRecords = Infinity;
  let pageNum = 0;

  while (offset < totalRecords) {
    const data = await fetchPage({ apiKey, postedFrom, postedTo, offset });
    if (data === null) {
      // Rate-limited past our backoff. Keep the pages we have; the load step
      // ingests them and the next scheduled run continues from a fresh window.
      console.log(`fetch.mjs: stopped early at offset ${offset} of ${totalRecords} (rate limit); ${pageNum} page(s) kept`);
      break;
    }
    totalRecords = Number(data.totalRecords) || 0;
    pageNum += 1;

    const outPath = path.join(args.out, `sam-page-${pageNum}.json`);
    await writeFile(outPath, JSON.stringify(data), 'utf8');

    const pageCount = (data.opportunitiesData || []).length;
    console.log(
      `fetch.mjs: wrote ${outPath} (offset=${offset}, totalRecords=${totalRecords}, records=${pageCount})`
    );

    if (pageCount === 0) break; // safety valve: never spin if the API stops returning rows
    offset += PAGE_LIMIT;
    if (offset < totalRecords) await sleep(THROTTLE_MS); // stay under SAM's burst limit
  }

  console.log(`fetch.mjs: done, ${pageNum} page(s) written to ${args.out}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
