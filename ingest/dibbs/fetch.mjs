#!/usr/bin/env node
// ingest/dibbs/fetch.mjs
// DIBBS (DLA Internet Bid Board System) award-grid fetcher for GitHub
// Actions US runners (see docs/architecture.md #3 — DIBBS geoblocks/
// CDN-blocks non-US traffic, so this must never run from a BA machine).
//
// DIBBS sits behind a DoD consent-to-monitoring banner: the first GET to
// https://www.dibbs.bsm.dla.mil/ returns that banner page instead of
// content, and a cookie-bearing accept step is required before real pages
// are reachable. CONFIRMED (first live Actions run, 2026-07-12; capture run,
// 2026-07-13 — see docs/dibbs-ingest-findings.md): the CookieJar /
// jarFetchFollow / consent-banner machinery below reaches every www page
// tested once the banner is cleared.
//
// There is no batch-file index any more (see docs/dibbs-ingest-findings.md)
// — award data lives only in the ASP.NET GridView rendered by
// /Awards/AwdRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY (one page
// per business day the awards posted on), and RFQ data likewise only in
// /Rfq/RfqRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY. This
// fetcher walks each grid's postback pagination
// (__doPostBack('ctl00$cph1$grdAwardSearch'|'ctl00$cph1$grdRfqSearch','Page$N'))
// for each of the last --days business days and writes each page's raw HTML
// to --out, unparsed — ingest/dibbs/parse.mjs does the parsing
// (parseAwardGrid / parseRfqGrid).
//
// CLI:
//   node fetch.mjs --type awd --days 3 --out dir/   (default type: awd)
//   node fetch.mjs --type rfq --days 3 --out dir/
//   node fetch.mjs --type awd --dates 04-15-2026,01-15-2026 --max-pages 1 --out dir/
//     (explicit posting dates instead of the last N business days; --max-pages
//      caps the pages fetched per date, used by the depth probe)
//
// Writes one file per date+page: dir/awd-MM-DD-YYYY-pN.html or
// dir/rfq-MM-DD-YYYY-pN.html depending on --type.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePagination, extractAspNetForm } from './parse.mjs';

const BASE_URL = 'https://www.dibbs.bsm.dla.mil';
const UA = 'nsnexplorer.com ingest (contact: hello@nsnexplorer.com)';
const REQUEST_INTERVAL_MS = 1500;
// DIBBS's F5 sometimes accepts a connection and then never answers. Without
// a deadline that one request hangs until the runner's 6-hour limit kills the
// job, so every request gets a hard timeout and goes through the normal
// retry path instead.
const REQUEST_TIMEOUT_MS = 90000;
// Safety valve against a pagination-parsing bug looping forever; DIBBS award
// grids have run into the hundreds of pages for a single busy posting day,
// so this is deliberately generous, not a realistic expected count.
const MAX_PAGES_PER_DATE = 1000;

// Per-grid-type config: URL path, postback __EVENTTARGET grid id (also the
// parsePagination fallback when a page's pager doesn't echo it), and the
// filename prefix fetched pages are written under. 'awd' is the default —
// existing callers (e.g. .github/workflows/ingest-daily.yml) invoke this
// script without --type and must keep getting exactly today's behavior.
const GRID_TYPES = {
  awd: {
    urlPath: '/Awards/AwdRecs.aspx',
    gridId: 'ctl00$cph1$grdAwardSearch',
    filePrefix: 'awd',
  },
  rfq: {
    urlPath: '/Rfq/RfqRecs.aspx',
    gridId: 'ctl00$cph1$grdRfqSearch',
    filePrefix: 'rfq',
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = { days: undefined, out: undefined, type: 'awd', dates: undefined, maxPages: MAX_PAGES_PER_DATE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a === '--dates') args.dates = argv[++i].split(',').map((d) => d.trim()).filter(Boolean);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
  }
  if (args.dates) {
    const bad = args.dates.filter((d) => !/^\d{2}-\d{2}-\d{4}$/.test(d));
    if (bad.length > 0 || args.dates.length === 0) throw new Error(`fetch.mjs: --dates takes MM-DD-YYYY values, got '${bad.join(', ')}'`);
  } else if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error('fetch.mjs: --days must be a positive integer');
  }
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1) throw new Error('fetch.mjs: --max-pages must be a positive integer');
  if (!args.out) throw new Error('fetch.mjs: --out is required');
  if (!Object.prototype.hasOwnProperty.call(GRID_TYPES, args.type)) {
    throw new Error(`fetch.mjs: --type must be one of ${Object.keys(GRID_TYPES).join(', ')}, got '${args.type}'`);
  }
  return args;
}

/** Minimal in-memory cookie jar, good enough for a single-host session. */
class CookieJar {
  constructor() {
    this._cookies = new Map(); // name -> value
  }
  absorb(headers) {
    const setCookie = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie')
        ? [headers.get('set-cookie')]
        : [];
    for (const raw of setCookie) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq === -1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      this._cookies.set(name, value);
    }
  }
  header() {
    return [...this._cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function jarFetch(jar, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const cookieHeader = jar.header();
  if (cookieHeader) headers['Cookie'] = cookieHeader;
  // DIBBS's WAF intermittently refuses connections from some runner IPs
  // and its F5 can tarpit the first attempt; retry with growing waits
  // before giving up on the whole run.
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      jar.absorb(res.headers);
      // Read the body under the same deadline: a response that stalls
      // mid-body would otherwise hang in res.text() with no timeout at all.
      const text = await res.text();
      res.text = async () => text;
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) {
        const wait = attempt * 20000;
        console.error(`jarFetch attempt ${attempt} failed for ${url} (${err.cause?.code || err.message}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/**
 * jarFetch that follows redirects (up to maxRedirects), absorbing cookies at
 * every hop — fetch()'s built-in redirect handling would drop Set-Cookie
 * from intermediate responses, and DIBBS's dodwarning.aspx flow depends on
 * exactly those cookies. Returns { res, url, html } for the final hop.
 * Method degrades to GET after the first hop (browser-like behavior).
 */
async function jarFetchFollow(jar, url, opts = {}, maxRedirects = 5) {
  let currentUrl = url;
  let currentOpts = opts;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await jarFetch(jar, currentUrl, currentOpts);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { res, url: currentUrl, html: await res.text() };
      // Drain the redirect body so the connection is reusable.
      await res.text();
      currentUrl = new URL(location, currentUrl).toString();
      currentOpts = {}; // degrade to plain GET on subsequent hops
      continue;
    }
    return { res, url: currentUrl, html: await res.text() };
  }
  throw new Error(`fetch.mjs: too many redirects starting from ${url}`);
}

/**
 * Detects a DoD consent-to-monitoring banner by looking for the standard
 * banner language DoD sites use. DIBBS wraps this in a page containing a
 * form to accept before proceeding.
 */
function looksLikeConsentBanner(html) {
  return /consent to monitoring|you are accessing a u\.s\. government/i.test(html);
}

/** Extracts the first <form ...>...</form> block, its action, method, and hidden inputs. */
function extractForm(html) {
  const formMatch = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const attrs = formMatch[1];
  const body = formMatch[2];

  const actionMatch = attrs.match(/action\s*=\s*"([^"]*)"/i);
  const methodMatch = attrs.match(/method\s*=\s*"([^"]*)"/i);

  const fields = {};
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(body))) {
    const inputAttrs = m[1];
    const nameMatch = inputAttrs.match(/name\s*=\s*"([^"]*)"/i);
    if (!nameMatch) continue;
    const valueMatch = inputAttrs.match(/value\s*=\s*"([^"]*)"/i);
    fields[nameMatch[1]] = valueMatch ? valueMatch[1] : '';
  }

  return {
    action: actionMatch ? actionMatch[1] : '',
    method: (methodMatch ? methodMatch[1] : 'POST').toUpperCase(),
    fields,
  };
}

/** True when a landing URL or page is the DIBBS dodwarning.aspx banner. */
function isDodWarning(url, html) {
  return /dodwarning\.aspx/i.test(url) || looksLikeConsentBanner(html);
}

/**
 * Clears the DIBBS dodwarning.aspx consent banner for this cookie jar.
 * `landing` is the { res, url, html } we got redirected to.
 *
 * Confirmed on first live Actions run (2026-07-12): GET /Downloads/Awd/
 * 302-redirects to /dodwarning.aspx?goto=/downloads/awd/. Standard ASP.NET
 * banner handling applies: visiting dodwarning.aspx sets the consent
 * cookie(s); if the page carries a <form>, submitting it (with all hidden
 * fields) completes the accept. We try the form when present, otherwise
 * rely on the cookies the banner GET itself set. The caller then retries
 * the original URL; if the banner still blocks, we log the full banner
 * HTML so the exact accept mechanism can be read from the Actions log.
 */
async function clearDodWarning(jar, landing) {
  const form = extractForm(landing.html);
  if (!form) return; // cookies from the banner GET may be all that's needed

  const actionUrl = form.action
    ? new URL(form.action, landing.url).toString()
    : landing.url;
  const body = new URLSearchParams(form.fields).toString();

  await sleep(REQUEST_INTERVAL_MS);
  await jarFetchFollow(jar, actionUrl, {
    method: form.method === 'GET' ? 'GET' : 'POST',
    headers: form.method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.method === 'GET' ? undefined : body,
  });
}

/**
 * Ensures the consent banner is cleared and returns the landing page for
 * `url`. Throws with a clear, nonzero-exit-producing error if the banner
 * still blocks after one accept attempt (CONFIRM ON FIRST RUN for any new
 * banner variant).
 */
async function getPage(jar, url) {
  await sleep(REQUEST_INTERVAL_MS);
  let landing = await jarFetchFollow(jar, url);

  if (isDodWarning(landing.url, landing.html)) {
    console.error(`DIBBS consent banner encountered at ${landing.url}; attempting accept...`);
    await clearDodWarning(jar, landing);
    await sleep(REQUEST_INTERVAL_MS);
    landing = await jarFetchFollow(jar, url);
  }

  if (isDodWarning(landing.url, landing.html)) {
    console.error('Consent banner still blocking after accept attempt. Banner HTML follows:');
    console.error(landing.html);
    throw new Error('fetch.mjs: consent banner did not clear (CONFIRM ON FIRST RUN)');
  }

  return landing;
}

/** Formats a Date as DIBBS's MM-DD-YYYY query-value format, in UTC. */
function formatMmDdYyyy(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}

/** Last `n` business days (Mon-Fri, UTC), most recent first, as MM-DD-YYYY strings. */
function businessDays(n) {
  const days = [];
  let back = 1;
  while (days.length < n) {
    const d = new Date(Date.now() - back * 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(formatMmDdYyyy(d));
    back += 1;
  }
  return days;
}

async function writePage(outDir, filePrefix, date, pageNum, html) {
  const filename = `${filePrefix}-${date}-p${pageNum}.html`;
  const outPath = path.join(outDir, filename);
  await writeFile(outPath, html, 'utf8');
  console.log(`fetch.mjs: wrote ${outPath}`);
}

/**
 * Fetches every page of the award or RFQ grid (per `gridType`) for a
 * single date, following postback pagination. The pager only shows a
 * window of nearby page numbers, so after every fetch we re-parse
 * pagination for newly visible Page$N values and keep going until none are
 * new.
 */
async function fetchDate(jar, outDir, gridType, date, maxPages = MAX_PAGES_PER_DATE) {
  const { urlPath, gridId: defaultGridId, filePrefix } = GRID_TYPES[gridType];
  const gridUrl = `${BASE_URL}${urlPath}?category=post&TypeSrch=dt&Value=${date}`;
  const page1 = await getPage(jar, gridUrl);
  await writePage(outDir, filePrefix, date, 1, page1.html);

  const visited = new Set([1]);
  const queued = new Set();
  let { gridId, pages } = parsePagination(page1.html);
  const queue = [];
  for (const p of pages) {
    queue.push(p);
    queued.add(p);
  }

  let currentHtml = page1.html;
  let currentUrl = page1.url;

  while (queue.length > 0) {
    if (visited.size >= maxPages) {
      if (maxPages >= MAX_PAGES_PER_DATE) console.error(`fetch.mjs: hit MAX_PAGES_PER_DATE (${MAX_PAGES_PER_DATE}) for ${date}; stopping pagination early`);
      break;
    }

    const pageArg = queue.shift();
    const pageNum = Number(pageArg.slice('Page$'.length));
    if (visited.has(pageNum)) continue;

    const form = extractAspNetForm(currentHtml);
    const postUrl = form.action ? new URL(form.action, currentUrl).toString() : currentUrl;
    const body = new URLSearchParams({
      ...form.fields,
      __EVENTTARGET: gridId || defaultGridId,
      __EVENTARGUMENT: pageArg,
    }).toString();

    await sleep(REQUEST_INTERVAL_MS);
    const resp = await jarFetchFollow(jar, postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (isDodWarning(resp.url, resp.html)) {
      console.error('Consent banner reappeared mid-pagination. Banner HTML follows:');
      console.error(resp.html);
      throw new Error(`fetch.mjs: consent banner blocked pagination for ${date} ${pageArg}`);
    }

    // Verify the pager actually advanced: a repeated first row number
    // means the postback re-rendered the same page (see extractAspNetForm
    // hidden-only note) — stop rather than saving duplicates.
    const firstRow = (html) => (html.match(/lblRowNum[^>]*>(\d+)</) || [])[1] ?? null;
    if (firstRow(resp.html) !== null && firstRow(resp.html) === firstRow(currentHtml)) {
      console.error(`fetch.mjs: pagination did not advance for ${date} ${pageArg} (first row ${firstRow(resp.html)}); stopping this date`);
      break;
    }
    visited.add(pageNum);
    currentHtml = resp.html;
    currentUrl = resp.url;
    await writePage(outDir, filePrefix, date, pageNum, currentHtml);

    const more = parsePagination(currentHtml);
    if (more.gridId) gridId = more.gridId;
    for (const p of more.pages) {
      const n = Number(p.slice('Page$'.length));
      if (!visited.has(n) && !queued.has(p)) {
        queue.push(p);
        queued.add(p);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const jar = new CookieJar();
  const dates = args.dates ?? businessDays(args.days);

  // One bad date must not cost the other dates: record the failure, keep
  // going, and exit nonzero at the end so the workflow can decide whether a
  // partial crawl is usable (incremental lanes) or not (full reconcile).
  const failed = [];
  for (const date of dates) {
    try {
      await fetchDate(jar, args.out, args.type, date, args.maxPages);
    } catch (err) {
      failed.push(date);
      console.error(`fetch.mjs: ${date} failed (${err.cause?.code || err.name}: ${err.message}); continuing`);
    }
  }
  console.log(`fetch.mjs: ${dates.length - failed.length}/${dates.length} dates fetched` +
    (failed.length ? `; FAILED: ${failed.join(', ')}` : ''));
  if (failed.length) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
