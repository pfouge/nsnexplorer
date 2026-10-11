#!/usr/bin/env node
// ingest/sam-entities/fetch.mjs
// Downloads the latest SAM.gov PUBLIC V2 monthly entity extract (a ZIP holding one pipe-delimited
// .dat file) with the Extracts API, streaming it to disk. See map.mjs for the documentation links.
//
//   GET https://api.sam.gov/data-services/v1/extracts
//       ?api_key=KEY&fileType=ENTITY&sensitivity=PUBLIC&frequency=MONTHLY[&date=MM/YYYY]
//
// The key is a non-federal key without a role: 10 requests per day, so a run makes at most
// MAX_REQUESTS (3): one real attempt plus two retries after a 429 / 5xx / network error. A 4xx other
// than 429 fails at once (400 carries the API's own message, e.g. "file not found"). The API key is
// never printed. If the endpoint answers 200 with JSON instead of the file, the body is searched for
// a download URL (the docs describe the 200 as JSON but their examples save a ZIP); that follow-up
// request counts against the same budget.
//
// CLI: node fetch.mjs --out dir/ [--date MM/YYYY]
// Env: SAM_API_KEY (required), SAM_EXTRACT_BASE_URL (tests; default the production endpoint).

import { createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_BASE_URL = 'https://api.sam.gov/data-services/v1/extracts';
export const MAX_REQUESTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redact(text, key) {
  return key ? String(text).split(key).join('***') : String(text);
}

function fileNameFrom(res, fallback) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]).trim() : '';
  // keep only a safe basename
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.zip$/i.test(base) ? base : fallback;
}

function findUrl(json) {
  const seen = [];
  (function walk(v) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) seen.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(json);
  return seen[0] ?? null;
}

/**
 * @param {{ apiKey: string, outDir: string, date?: string, baseUrl?: string, fetchImpl?: typeof fetch,
 *           backoffMs?: number, log?: (s: string) => void }} o
 * @returns {Promise<{ path: string, fileName: string, bytes: number, requests: number }>}
 */
export async function fetchExtract({ apiKey, outDir, date, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, backoffMs = 5000, log = console.log }) {
  if (!apiKey) throw new Error('fetch.mjs: SAM_API_KEY is not set');
  await mkdir(outDir, { recursive: true });

  const first = new URL(baseUrl);
  first.searchParams.set('api_key', apiKey);
  first.searchParams.set('fileType', 'ENTITY');
  first.searchParams.set('sensitivity', 'PUBLIC');
  first.searchParams.set('frequency', 'MONTHLY');
  if (date) first.searchParams.set('date', date);

  let target = first.toString();
  let requests = 0;
  let lastErr;
  while (requests < MAX_REQUESTS) {
    requests += 1;
    let res;
    try {
      res = await fetchImpl(target, { redirect: 'follow', headers: { Accept: 'application/zip, application/octet-stream, application/json' }, signal: AbortSignal.timeout(30 * 60 * 1000) });
    } catch (err) {
      lastErr = new Error(`request ${requests}/${MAX_REQUESTS} failed: ${redact(err.cause?.code || err.message, apiKey)}`);
      log(`warn: ${lastErr.message}`);
      if (requests < MAX_REQUESTS) await sleep(backoffMs * requests);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`request ${requests}/${MAX_REQUESTS}: HTTP ${res.status}`);
      log(`warn: ${lastErr.message}`);
      await res.body?.cancel().catch(() => {});
      if (requests < MAX_REQUESTS) await sleep(backoffMs * requests);
      continue;
    }
    if (!res.ok) {
      const body = redact((await res.text().catch(() => '')).slice(0, 400), apiKey);
      throw new Error(`SAM extracts API answered HTTP ${res.status}: ${body}`);
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.includes('json')) {
      const body = await res.text();
      let url = null;
      try { url = findUrl(JSON.parse(body)); } catch { /* not JSON after all */ }
      if (!url) throw new Error(`SAM extracts API answered 200 with JSON and no download URL: ${redact(body.slice(0, 400), apiKey)}`);
      log('note: API answered with JSON; following its download URL');
      target = url;
      continue;
    }

    const fileName = fileNameFrom(res, `SAM_PUBLIC_MONTHLY_V2_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.ZIP`);
    const dest = path.join(outDir, fileName);
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    } catch (err) {
      await rm(dest, { force: true });
      lastErr = new Error(`request ${requests}/${MAX_REQUESTS}: download interrupted (${redact(err.message, apiKey)})`);
      log(`warn: ${lastErr.message}`);
      if (requests < MAX_REQUESTS) await sleep(backoffMs * requests);
      continue;
    }
    const fh = await open(dest, 'r');
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    const { size } = await fh.stat();
    await fh.close();
    if (head.toString('latin1', 0, 2) !== 'PK') {
      await rm(dest, { force: true });
      throw new Error(`downloaded file is not a ZIP (${size} bytes, content-type ${type || 'unknown'})`);
    }
    return { path: dest, fileName, bytes: size, requests };
  }
  throw new Error(`gave up after ${requests} request(s): ${lastErr?.message ?? 'no response'}`);
}

function parseArgs(argv) {
  const args = { out: undefined, date: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--date') args.date = argv[++i];
  }
  if (!args.out) throw new Error('fetch.mjs: --out is required');
  if (args.date && !/^\d{2}\/\d{4}$/.test(args.date)) throw new Error('fetch.mjs: --date must be MM/YYYY');
  return args;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  fetchExtract({ apiKey: process.env.SAM_API_KEY, outDir: args.out, date: args.date, baseUrl: process.env.SAM_EXTRACT_BASE_URL || DEFAULT_BASE_URL })
    .then((r) => console.log(`fetched ${r.path} (${r.bytes} bytes, ${r.requests} request(s))`))
    .catch((err) => {
      console.error(redact(err.message, process.env.SAM_API_KEY));
      process.exit(1);
    });
}
