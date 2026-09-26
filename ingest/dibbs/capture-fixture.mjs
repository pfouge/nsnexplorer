#!/usr/bin/env node
// ingest/dibbs/capture-fixture.mjs
// One-shot fixture capture for the DIBBS award-grid parser rewrite
// (docs/dibbs-ingest-findings.md "Next steps"). Runs ONLY on GitHub
// Actions US runners (compliance fence, docs/architecture.md #3).
//
// Captures into ingest/dibbs/fixtures/:
//   awd-dates.html    — /Awards/AwdDates.aspx?category=recent
//   awd-grid-p1.html  — first per-date award grid page
//   capture-meta.json — URLs + timestamps + discovered link inventory
//
// Delete along with probe.mjs and dibbs-probe.yml once the grid scraper
// ships. Etiquette: 1.5s between requests, identifying User-Agent,
// public listing pages only.

import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = 'https://www.dibbs.bsm.dla.mil';
const UA = 'nsnexplorer.com ingest (contact: hello@nsnexplorer.com)';
const OUT = 'ingest/dibbs/fixtures';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CookieJar {
  constructor() { this._c = new Map(); }
  absorb(headers) {
    const sc = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie') ? [headers.get('set-cookie')] : [];
    for (const raw of sc) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq !== -1) this._c.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  header() { return [...this._c.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function jarFetchFollow(jar, url, opts = {}, maxRedirects = 5) {
  let currentUrl = url;
  let currentOpts = opts;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const headers = { 'User-Agent': UA, ...(currentOpts.headers || {}) };
    const cookie = jar.header();
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(currentUrl, { ...currentOpts, headers, redirect: 'manual' });
    jar.absorb(res.headers);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { res, url: currentUrl, html: await res.text() };
      await res.text();
      currentUrl = new URL(location, currentUrl).toString();
      currentOpts = {};
      continue;
    }
    return { res, url: currentUrl, html: await res.text() };
  }
  throw new Error(`too many redirects from ${url}`);
}

function extractForm(html) {
  const formMatch = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const actionMatch = formMatch[1].match(/action\s*=\s*"([^"]*)"/i);
  const fields = {};
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(formMatch[2]))) {
    const name = m[1].match(/name\s*=\s*"([^"]*)"/i);
    if (!name) continue;
    const value = m[1].match(/value\s*=\s*"([^"]*)"/i);
    fields[name[1]] = value ? value[1] : '';
  }
  return { action: actionMatch ? actionMatch[1] : '', fields };
}

const isBanner = (url, html) =>
  /dodwarning\.aspx/i.test(url) || /consent to monitoring|you are accessing a u\.s\. government/i.test(html);

async function getPage(jar, url) {
  let landing = await jarFetchFollow(jar, url);
  if (isBanner(landing.url, landing.html)) {
    const form = extractForm(landing.html);
    if (form) {
      const actionUrl = form.action ? new URL(form.action, landing.url).toString() : landing.url;
      await jarFetchFollow(jar, actionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form.fields).toString(),
      });
    }
    await sleep(1500);
    landing = await jarFetchFollow(jar, url);
  }
  if (isBanner(landing.url, landing.html)) {
    throw new Error(`consent banner did not clear for ${url}`);
  }
  return landing;
}

/** True when HTML looks like a populated award grid (GridView rows). */
function looksLikeGrid(html) {
  return /lbl(Nsn|Niin|Solicitation|Pr)\b/i.test(html) || /GridView/i.test(html);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const jar = new CookieJar();
  const meta = { capturedAt: new Date().toISOString(), pages: [], probes: [] };

  // The AwdDates.aspx date list only renders with JavaScript (confirmed by
  // capture run #1), but per-date grid pages are directly addressable —
  // the RFQ side (verified live by github.com/kasin-it/test1) uses
  //   /Rfq/RfqRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY
  // Awards should mirror it. Probe recent dates x candidate category
  // values until a populated grid comes back.
  const fmt = (d) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;
  const days = [];
  for (let back = 1; back <= 7; back += 1) {
    const d = new Date(Date.now() - back * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // awards post on business days
    days.push(fmt(d));
  }

  const candidates = [];
  for (const day of days) {
    for (const cat of ['post', 'awddt']) {
      candidates.push(`${BASE_URL}/Awards/AwdRecs.aspx?category=${cat}&TypeSrch=dt&Value=${day}`);
    }
  }

  const { existsSync } = await import('node:fs');
  let captured = existsSync(`${OUT}/awd-grid-p1.html`);
  if (captured) console.log('awd-grid-p1.html already captured; skipping award probe');
  for (const url of captured ? [] : candidates) {
    await sleep(1500);
    const page = await getPage(jar, url);
    const ok = page.res.status === 200 && looksLikeGrid(page.html);
    meta.probes.push({ url, status: page.res.status, bytes: page.html.length, grid: ok });
    console.log(`${ok ? 'GRID' : 'miss'} ${page.res.status} ${page.html.length}b ${url}`);
    if (!ok) continue;

    await writeFile(`${OUT}/awd-grid-p1.html`, page.html, 'utf8');
    meta.pages.push({ file: 'awd-grid-p1.html', url: page.url, status: page.res.status, bytes: page.html.length });
    // Structural sniff for the parser spec: span ids (normalized), row
    // count, pagination controls.
    const spanIds = [...page.html.matchAll(/<span[^>]+id="([^"]+)"/gi)].map((x) => x[1]);
    meta.gridSpanIdSample = [...new Set(spanIds.map((id) => id.replace(/_(ctl)?\d+_/g, '_N_')))].slice(0, 80);
    meta.gridPostbacks = [...new Set([...page.html.matchAll(/__doPostBack\('([^']+)'/g)].map((x) => x[1]))].slice(0, 40);
    captured = true;
    break;
  }
  if (!captured) console.error('No populated award grid found across candidate URLs; see capture-meta.json probes.');

  // RFQ grid fixture (for the unit-price join): the RFQ side is verified
  // live by github.com/kasin-it/test1 at
  //   /Rfq/RfqRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY
  for (const day of days) {
    const url = `${BASE_URL}/Rfq/RfqRecs.aspx?category=post&TypeSrch=dt&Value=${day}`;
    await sleep(1500);
    const page = await getPage(jar, url);
    const ok = page.res.status === 200 && looksLikeGrid(page.html);
    meta.probes.push({ url, status: page.res.status, bytes: page.html.length, grid: ok });
    console.log(`${ok ? 'RFQ GRID' : 'rfq miss'} ${page.res.status} ${page.html.length}b ${url}`);
    if (!ok) continue;
    await writeFile(`${OUT}/rfq-grid-p1.html`, page.html, 'utf8');
    meta.pages.push({ file: 'rfq-grid-p1.html', url: page.url, status: page.res.status, bytes: page.html.length });
    const spanIds = [...page.html.matchAll(/<span[^>]+id="([^"]+)"/gi)].map((x) => x[1]);
    meta.rfqSpanIdSample = [...new Set(spanIds.map((id) => id.replace(/_(ctl)?\d+_/g, '_N_')))].slice(0, 80);
    break;
  }

  await writeFile(`${OUT}/capture-meta.json`, JSON.stringify(meta, null, 2), 'utf8');
  console.log('capture complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
