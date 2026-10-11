// ingest/supplier-web/crawl.mjs
// Polite, small-footprint crawler for a supplier's own website.
//
//  - User-Agent NSNExplorerBot/1.0 (+https://nsnexplorer.com/about/#crawler)
//  - robots.txt is fetched per origin and honoured (our token and "*"; the more specific group wins;
//    longest matching rule wins, Allow beats Disallow on a tie; * and $ wildcards). A 4xx robots.txt
//    means "no rules"; a 5xx or unreachable robots.txt is treated as "disallow everything" (RFC 9309)
//  - at most MAX_PAGES (4) pages per site: the home page plus the best same-site links for
//    contact / about / capabilities / quality
//  - at least MIN_DELAY_MS (2 s) between two requests to the same host (robots.txt included; a
//    Crawl-delay above that is honoured up to 10 s), 15 s timeout, 1.5 MB per response,
//    text/html only, at most 5 redirects (each hop checked against robots.txt again)
//  - hosts that resolve to private / loopback / link-local addresses are refused
//    (set allowPrivate for tests that talk to 127.0.0.1)

import dns from 'node:dns/promises';
import net from 'node:net';
import { extractLinks, extractTitle } from './extract.mjs';

export const USER_AGENT = 'NSNExplorerBot/1.0 (+https://nsnexplorer.com/about/#crawler)';
export const BOT_TOKEN = 'nsnexplorerbot';
export const MAX_PAGES = 4;
export const MIN_DELAY_MS = 2000;
export const TIMEOUT_MS = 15000;
export const MAX_BYTES = 1.5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const MAX_CRAWL_DELAY_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- robots.txt

/** Parses robots.txt into groups: [{ agents: string[], rules: [{allow, pattern}], crawlDelay }]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], crawlDelay: null };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value === '') continue; // empty Disallow = allow everything; empty Allow = no-op
      cur.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  return groups;
}

function patternToRegex(pattern) {
  let p = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (p.endsWith('\\$')) p = `${p.slice(0, -2)}$`;
  return new RegExp(`^${p}`);
}

/** The group that applies to us: the one naming our token, else "*", else none. */
export function groupFor(groups) {
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== '*' && (BOT_TOKEN.includes(a) || a.includes(BOT_TOKEN))));
  const star = groups.filter((g) => g.agents.includes('*'));
  const use = mine.length ? mine : star;
  if (!use.length) return null;
  return { rules: use.flatMap((g) => g.rules), crawlDelay: use.map((g) => g.crawlDelay).find((d) => d !== null) ?? null };
}

/** @param {{rules: {allow: boolean, pattern: string}[]} | null} group  @param {string} pathAndQuery */
export function robotsAllows(group, pathAndQuery) {
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    const len = r.pattern.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------- networking helpers

export class HostLimiter {
  constructor(minDelayMs = MIN_DELAY_MS) {
    this.minDelayMs = minDelayMs;
    this.next = new Map();
  }
  async wait(host, delayMs = this.minDelayMs) {
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + delayMs);
    if (at > now) await sleep(at - now);
  }
  /** Called when a request to `host` finishes: the next one waits a full delay from now. */
  done(host, delayMs = this.minDelayMs) {
    this.next.set(host, Date.now() + delayMs);
  }
}

function privateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = addr.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

async function assertPublicHost(hostname, allowPrivate) {
  if (allowPrivate) return;
  const h = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$|\.localdomain$/i.test(h)) throw new Error('private host');
  if (net.isIP(h)) {
    if (privateAddress(h)) throw new Error('private address');
    return;
  }
  const addrs = await dns.lookup(h, { all: true });
  if (addrs.some((a) => privateAddress(a.address))) throw new Error('resolves to a private address');
}

function decoderFor(contentType, headBytes) {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!cs) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(Buffer.from(headBytes).toString('latin1', 0, 2048))?.[1];
  try {
    return new TextDecoder(cs || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = Buffer.concat(chunks).subarray(0, maxBytes);
  return { buf, truncated };
}

/**
 * @typedef {{ allowPrivate?: boolean, fetchImpl?: typeof fetch, limiter?: HostLimiter, timeoutMs?: number,
 *             maxBytes?: number, robotsCache?: Map<string, Promise<any>> }} CrawlOpts
 */

async function getRobots(origin, o) {
  if (!o.robotsCache.has(origin)) {
    o.robotsCache.set(origin, (async () => {
      const u = new URL('/robots.txt', origin);
      let res;
      try {
        res = await rawGet(u, o, { maxBytes: 512 * 1024, anyText: true });
      } catch (err) {
        return { unavailable: true, error: `robots.txt: ${err.message}` };
      }
      if (res.status >= 500) return { unavailable: true, error: `robots.txt answered HTTP ${res.status}` };
      if (res.status >= 400 || res.status < 200) return { group: null };
      const group = groupFor(parseRobots(res.text));
      return { group };
    })());
  }
  return o.robotsCache.get(origin);
}

/** One HTTP GET with limiter, timeout, size cap and no redirect following. */
async function rawGet(url, o, { maxBytes = o.maxBytes ?? MAX_BYTES, anyText = false } = {}) {
  await assertPublicHost(url.hostname, o.allowPrivate);
  const host = url.host;
  await o.limiter.wait(host);
  try {
    const res = await (o.fetchImpl ?? fetch)(url.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'en-US,en;q=0.8' },
      signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, location, contentType, text: '' };
    }
    const isHtml = /text\/html|application\/xhtml\+xml/.test(contentType);
    const isText = /^text\//.test(contentType) || contentType === '';
    if (!(anyText ? isText || isHtml : isHtml)) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, contentType, text: '', notHtml: true };
    }
    const { buf, truncated } = await readCapped(res, maxBytes);
    const text = decoderFor(contentType, buf.subarray(0, 2048)).decode(buf);
    return { status: res.status, contentType, text, truncated };
  } finally {
    o.limiter.done(host, o.robotsDelayMs?.get(host) ?? o.limiter.minDelayMs);
  }
}

/**
 * GET with robots.txt checks and up to MAX_REDIRECTS redirects.
 * @returns {Promise<{ ok: boolean, reason?: string, status?: number, finalUrl?: string, html?: string, error?: string }>}
 *   reason: 'robots' | 'robots_unavailable' | 'not_html' | 'http' | 'network' | 'redirects'
 */
export async function politeGet(startUrl, o) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'network', error: `unsupported scheme ${url.protocol}` };
    const robots = await getRobots(url.origin, o);
    if (robots.unavailable) return { ok: false, reason: 'robots_unavailable', error: robots.error };
    if (!robotsAllows(robots.group, url.pathname + url.search)) return { ok: false, reason: 'robots', finalUrl: url.toString() };
    if (robots.group?.crawlDelay) {
      (o.robotsDelayMs ??= new Map()).set(url.host, Math.min(MAX_CRAWL_DELAY_MS, Math.max(o.limiter.minDelayMs, robots.group.crawlDelay * 1000)));
    }
    let res;
    try {
      res = await rawGet(url, o);
    } catch (err) {
      const code = err.cause?.code || err.code;
      return { ok: false, reason: 'network', error: err.name === 'TimeoutError' ? 'timed out' : String(code || err.message).slice(0, 120) };
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      try {
        url = new URL(res.location, url);
      } catch {
        return { ok: false, reason: 'http', status: res.status, error: 'bad redirect' };
      }
      continue;
    }
    if (res.status >= 400 || res.status < 200) return { ok: false, reason: 'http', status: res.status, error: `HTTP ${res.status}`, finalUrl: url.toString() };
    if (res.notHtml) return { ok: false, reason: 'not_html', status: res.status, error: `not HTML (${res.contentType || 'no content type'})`, finalUrl: url.toString() };
    return { ok: true, status: res.status, finalUrl: url.toString(), html: res.text, truncated: res.truncated };
  }
  return { ok: false, reason: 'redirects', error: `more than ${MAX_REDIRECTS} redirects` };
}

// ---------------------------------------------------------------- link choice

const stripWww = (h) => h.toLowerCase().replace(/^www\./, '');
export const sameSite = (a, b) => stripWww(new URL(a).hostname) === stripWww(new URL(b).hostname);

const CATEGORIES = {
  contact: { path: /contact|reach-us|get-in-touch|locations?|request-a-quote|\brfq\b|quote/i, text: /contact|reach us|get in touch|request a quote|\brfq\b|locations?/i },
  about: { path: /about|company|who-we-are|our-story|history|profile|overview/i, text: /about|company|who we are|our story|history|profile/i },
  capabilities: { path: /capabilit|products?|services|what-we-do|manufactur|solutions|catalog|offerings|machining|fabrication/i, text: /capabilit|products?|services|what we do|manufactur|solutions|catalog/i },
  quality: { path: /quality|certif|iso|as9100|compliance|accredit/i, text: /quality|certif|iso\b|as9100|compliance|accredit/i },
};
// contact first: phone and email are the point; quality only when one of the others is missing.
const PRIORITY = ['contact', 'about', 'capabilities', 'quality'];
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|docx?|xlsx?|pptx?|mp[34]|mov|avi|xml|json|css|js)(\?|$)/i;

/**
 * Picks up to `max` same-site links, best match per category, in PRIORITY order. Each pick also carries
 * the next-best candidates for its category (`alts`), tried if the first one turns out dead.
 */
export function chooseLinks(links, baseUrl, max = MAX_PAGES - 1) {
  const home = new URL(baseUrl);
  const scored = {};
  for (const l of links) {
    let u;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.toString(), baseUrl) || SKIP_EXT.test(u.pathname)) continue;
    u.hash = '';
    if (u.pathname === home.pathname && u.search === home.search) continue;
    const depth = u.pathname.split('/').filter(Boolean).length;
    for (const [cat, re] of Object.entries(CATEGORIES)) {
      let score = 0;
      if (re.path.test(u.pathname)) score += 3;
      if (re.text.test(l.text || '')) score += 2;
      if (!score) continue;
      score -= Math.min(depth, 4) * 0.1; // /contact beats /about/team/contact-our-staff
      const url = u.toString();
      const list = (scored[cat] ??= new Map());
      list.set(url, Math.max(list.get(url) ?? -Infinity, score));
    }
  }
  const out = [];
  for (const cat of PRIORITY) {
    const ranked = [...(scored[cat] ?? [])].sort((a, b) => b[1] - a[1]).map(([url]) => url);
    const fresh = ranked.filter((url) => !out.some((o) => o.url === url));
    if (!fresh.length) continue;
    out.push({ category: cat, url: fresh[0], alts: fresh.slice(1, 3) });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- the crawl

/**
 * @param {string} startUrl
 * @param {CrawlOpts} opts
 * @returns {Promise<{ status: 'crawled'|'robots_blocked'|'unreachable'|'no_text', finalUrl: string|null,
 *                     pages: {url:string,title:string|null,html:string,category:string}[], error: string|null }>}
 */
export async function crawlSite(startUrl, opts = {}) {
  const o = {
    ...opts,
    limiter: opts.limiter ?? new HostLimiter(),
    robotsCache: opts.robotsCache ?? new Map(),
  };

  let home = await politeGet(startUrl, o);
  // Old supplier sites often have a broken certificate or no TLS at all: try plain http once.
  if (!home.ok && home.reason === 'network' && startUrl.startsWith('https://')) {
    const alt = await politeGet(`http://${startUrl.slice('https://'.length)}`, o);
    if (alt.ok || alt.reason === 'robots') home = alt;
  }
  if (!home.ok) {
    if (home.reason === 'robots') return { status: 'robots_blocked', finalUrl: home.finalUrl ?? null, pages: [], error: null };
    if (home.reason === 'not_html') return { status: 'no_text', finalUrl: home.finalUrl ?? null, pages: [], error: home.error };
    return { status: 'unreachable', finalUrl: null, pages: [], error: home.error || `HTTP ${home.status}` };
  }

  const pages = [{ url: home.finalUrl, title: extractTitle(home.html), html: home.html, category: 'home' }];
  const picks = chooseLinks(extractLinks(home.html, home.finalUrl), home.finalUrl);
  for (const pick of picks) {
    if (pages.length >= MAX_PAGES) break;
    // Try the best link for this category, then its runners-up if it is dead, off-site or already read.
    for (const url of [pick.url, ...pick.alts]) {
      if (pages.some((p) => p.url === url)) break;
      const r = await politeGet(url, o);
      if (!r.ok || !sameSite(r.finalUrl, home.finalUrl) || pages.some((p) => p.url === r.finalUrl)) continue;
      pages.push({ url: r.finalUrl, title: extractTitle(r.html), html: r.html, category: pick.category });
      break;
    }
  }
  return { status: 'crawled', finalUrl: home.finalUrl, pages, error: null };
}
