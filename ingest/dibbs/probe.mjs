#!/usr/bin/env node
// ingest/dibbs/probe.mjs
// One-shot diagnostic for GitHub Actions US runners: clears the DIBBS DoD
// consent banner, then probes candidate award/RFQ index URLs and prints
// status + landing URL + a snippet of each response so the real page
// structure can be read from the Actions log. Read-only; writes nothing.
//
// Context (2026-07-12): /Downloads/Awd|RFQ/ batch-file indexes do not exist
// on www.dibbs.bsm.dla.mil (IIS "resource removed"). Third-party scrapers
// verified the live structure instead: RfqDates.aspx?category=recent →
// RfqRecs.aspx per-date grids on www; PDFs on dibbs2 (F5 WAF, browser-only).
// This probe confirms which paths respond for awards and RFQs.

const BASE = 'https://www.dibbs.bsm.dla.mil';

const CANDIDATES = [
  '/',
  '/RFQ/RfqDates.aspx?category=recent',
  '/RFQ/RFQDates.aspx?category=recent',
  '/Awards/AwdDates.aspx?category=recent',
  '/Awards/AwardDates.aspx?category=recent',
  '/Awards/',
  '/AWD/AwdDates.aspx?category=recent',
  '/Downloads/',
  '/Refs/',
];

class CookieJar {
  constructor() { this._cookies = new Map(); }
  absorb(headers) {
    const setCookie = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : headers.get('set-cookie') ? [headers.get('set-cookie')] : [];
    for (const raw of setCookie) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq === -1) continue;
      this._cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  header() { return [...this._cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function jarFetch(jar, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const cookie = jar.header();
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  jar.absorb(res.headers);
  return res;
}

async function follow(jar, url, opts = {}, max = 6) {
  let cur = url; let curOpts = opts;
  for (let i = 0; i <= max; i += 1) {
    const res = await jarFetch(jar, cur, curOpts);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.text();
      cur = new URL(res.headers.get('location'), cur).toString();
      curOpts = {};
      continue;
    }
    return { res, url: cur, html: await res.text() };
  }
  throw new Error(`too many redirects from ${url}`);
}

function extractForm(html) {
  const m = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!m) return null;
  const action = (m[1].match(/action\s*=\s*"([^"]*)"/i) || [])[1] || '';
  const fields = {};
  const re = /<input\b([^>]*)>/gi;
  let x;
  while ((x = re.exec(m[2]))) {
    const name = (x[1].match(/name\s*=\s*"([^"]*)"/i) || [])[1];
    if (!name) continue;
    fields[name] = (x[1].match(/value\s*=\s*"([^"]*)"/i) || [])[1] || '';
  }
  return { action, fields };
}

function snippet(html, n = 1200) {
  return html.replace(/\s+/g, ' ').slice(0, n);
}

async function main() {
  const jar = new CookieJar();

  // Clear the banner once: land on it via the homepage, submit its form.
  const first = await follow(jar, `${BASE}/`);
  console.log(`[banner] landed at ${first.url} (HTTP ${first.res.status})`);
  if (/dodwarning\.aspx/i.test(first.url)) {
    const form = extractForm(first.html);
    console.log(`[banner] form action=${form ? form.action : 'NONE'} fields=${form ? Object.keys(form.fields).join(',') : '-'}`);
    if (form) {
      const actionUrl = form.action ? new URL(form.action, first.url).toString() : first.url;
      await follow(jar, actionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form.fields).toString(),
      });
      console.log(`[banner] accept POSTed; cookies now: ${jar.header()}`);
    }
  }

  for (const p of CANDIDATES) {
    try {
      const { res, url, html } = await follow(jar, `${BASE}${p}`);
      console.log(`\n=== ${p} → HTTP ${res.status} @ ${url}`);
      console.log(snippet(html));
    } catch (err) {
      console.log(`\n=== ${p} → ERROR ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
