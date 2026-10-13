// node:test suite for crawl.mjs against the local fixture web (fixtures/sites.mjs).
// Run: node --test ingest/supplier-web/crawl.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite, parseRobots, groupFor, robotsAllows, chooseLinks, HostLimiter, USER_AGENT, MAX_PAGES } from './crawl.mjs';
import { startFixtureSites, virtualFetch } from './fixtures/sites.mjs';

let web;
before(async () => { web = await startFixtureSites(); });
after(async () => { await web.close(); });

const opts = (extra = {}) => ({ fetchImpl: virtualFetch(web.port), allowPrivate: true, limiter: new HostLimiter(5), ...extra });
const hits = (host) => web.log.filter((l) => l.host === host);

test('robots.txt: our group beats *, longest rule wins, Allow wins ties, wildcards and $', () => {
  const g = groupFor(parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: NSNExplorerBot\nDisallow: /contact\nAllow: /contact-sales\nDisallow: /*.pdf$\nCrawl-delay: 3\n'));
  assert.equal(g.crawlDelay, 3);
  assert.equal(robotsAllows(g, '/'), true);
  assert.equal(robotsAllows(g, '/contact'), false);
  assert.equal(robotsAllows(g, '/contact-sales'), true);
  assert.equal(robotsAllows(g, '/files/a.pdf'), false);
  assert.equal(robotsAllows(g, '/files/a.pdf?x=1'), true);
  const star = groupFor(parseRobots('User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n'));
  assert.equal(robotsAllows(star, '/private/x'), false);
  assert.equal(robotsAllows(star, '/public'), true);
  assert.equal(robotsAllows(groupFor(parseRobots('User-agent: *\nDisallow:\n')), '/anything'), true); // empty Disallow
  assert.equal(robotsAllows(groupFor(parseRobots('')), '/x'), true);
});

test('chooseLinks: best same-site link per category, contact first, never off-site or files', () => {
  const links = [
    { href: 'https://x.test/about-us', text: 'About us' },
    { href: 'https://x.test/about/team/our-staff', text: 'Staff' },
    { href: 'https://x.test/contact', text: 'Contact' },
    { href: 'https://www.x.test/products', text: 'Products' },
    { href: 'https://x.test/quality', text: 'Quality' },
    { href: 'https://x.test/files/catalog.pdf', text: 'Catalog' },
    { href: 'https://evil.example/contact', text: 'Contact' },
    { href: 'https://x.test/careers', text: 'Careers' },
  ];
  const picks = chooseLinks(links, 'https://x.test/');
  assert.deepEqual(picks.map((p) => p.category), ['contact', 'about', 'capabilities']);
  assert.equal(picks[1].url, 'https://x.test/about-us');
  assert.equal(picks.length, MAX_PAGES - 1);
});

test('normal site: home + contact + about + products, boilerplate kept in html, our User-Agent sent', async () => {
  const r = await crawlSite('http://acme-parts.test/', opts());
  assert.equal(r.status, 'crawled');
  assert.deepEqual(r.pages.map((p) => p.category), ['home', 'contact', 'about', 'capabilities']);
  assert.ok(r.pages.length <= MAX_PAGES);
  assert.ok(!r.pages.some((p) => p.url.endsWith('.pdf') || p.url.endsWith('/careers')));
  assert.equal(r.pages[0].title, 'ACME Fasteners - Home');
  assert.ok(hits('acme-parts.test').length >= 5); // robots.txt + 4 pages
  assert.ok(hits('acme-parts.test').every((l) => l.ua === USER_AGENT));
  assert.equal(USER_AGENT, 'Mozilla/5.0 (compatible; NSNExplorerBot/1.0; +https://nsnexplorer.com/about/#crawler)');
});

test('robots disallow: status robots_blocked and nothing but /robots.txt is requested', async () => {
  const r = await crawlSite('http://blocked.test/', opts());
  assert.equal(r.status, 'robots_blocked');
  assert.deepEqual(r.pages, []);
  assert.deepEqual(hits('blocked.test').map((l) => l.url), ['/robots.txt']);
});

test('robots disallow of one path: that page is skipped, the rest are read', async () => {
  const r = await crawlSite('http://partial.test/', opts());
  assert.equal(r.status, 'crawled');
  assert.deepEqual(r.pages.map((p) => new URL(p.url).pathname), ['/', '/about']);
  assert.ok(!hits('partial.test').some((l) => l.url === '/contact'));
});

test('slow site: times out and is unreachable', async () => {
  const r = await crawlSite('http://slow.test/', opts({ timeoutMs: 100 }));
  assert.equal(r.status, 'unreachable');
  assert.match(r.error, /timed out/);
});

test('redirect chain across hosts is followed; more than 5 redirects fails', async () => {
  const r = await crawlSite('http://redirect.test/', opts());
  assert.equal(r.status, 'crawled');
  assert.equal(r.finalUrl, 'http://www.redirect.test/home');
  const loop = await crawlSite('http://loop.test/', opts());
  assert.equal(loop.status, 'unreachable');
  assert.match(loop.error, /redirects/);
});

test('non-html home page: no_text; 404 home: unreachable; robots.txt 5xx: unreachable', async () => {
  assert.equal((await crawlSite('http://pdf.test/', opts())).status, 'no_text');
  const gone = await crawlSite('http://gone.test/', opts());
  assert.equal(gone.status, 'unreachable');
  assert.match(gone.error, /404/);
  const r500 = await crawlSite('http://robots500.test/', opts());
  assert.equal(r500.status, 'unreachable');
  assert.match(r500.error, /robots\.txt/);
  assert.deepEqual(hits('robots500.test').map((l) => l.url), ['/robots.txt']);
});

test('responses are capped at 1.5 MB', async () => {
  const r = await crawlSite('http://big.test/', opts());
  assert.equal(r.status, 'crawled');
  assert.ok(r.pages[0].html.length <= 1.5 * 1024 * 1024);
  assert.ok(r.pages[0].html.length > 1_000_000);
});

test('at least the configured delay between two requests to one host', async () => {
  const before = web.log.length;
  await crawlSite('http://acme-parts.test/', opts({ limiter: new HostLimiter(150) }));
  const mine = web.log.slice(before).filter((l) => l.host === 'acme-parts.test');
  assert.ok(mine.length >= 5);
  for (let i = 1; i < mine.length; i += 1) assert.ok(mine[i].at - mine[i - 1].at >= 140, `gap ${mine[i].at - mine[i - 1].at}ms between request ${i - 1} and ${i}`);
});

test('private addresses are refused unless allowed', async () => {
  const r = await crawlSite('http://127.0.0.1:9/', { fetchImpl: virtualFetch(web.port), limiter: new HostLimiter(1) });
  assert.equal(r.status, 'unreachable');
  assert.match(r.error, /private/);
});

test('urlVariants: www twin first, then plain http / https, never the start URL itself', async () => {
  const { urlVariants } = await import('./crawl.mjs');
  assert.deepEqual(urlVariants('https://www.x.test/'), ['https://x.test/', 'http://www.x.test/', 'http://x.test/']);
  assert.deepEqual(urlVariants('http://x.test/home'), ['http://www.x.test/home', 'https://x.test/home', 'https://www.x.test/home']);
  assert.deepEqual(urlVariants('https://x.test/', false), ['https://www.x.test/']);
});

const failing = (pred, code) => (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (pred(u)) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
  return virtualFetch(web.port)(input, init);
};

test('https that fails at robots.txt (TLS / refused) falls back to http and crawls', async () => {
  const r = await crawlSite('https://acme-parts.test/', opts({ fetchImpl: failing((u) => u.protocol === 'https:', 'ECONNREFUSED') }));
  assert.equal(r.status, 'crawled');
  assert.equal(r.finalUrl, 'http://acme-parts.test/');
});

test('a dead www host falls back to the bare domain; the error names the real cause when all fail', async () => {
  const r = await crawlSite('http://www.acme-parts.test/', opts({ fetchImpl: failing((u) => u.hostname.startsWith('www.'), 'ENOTFOUND') }));
  assert.equal(r.status, 'crawled');
  assert.equal(r.finalUrl, 'http://acme-parts.test/');
  const dead = await crawlSite('http://acme-parts.test/', opts({ fetchImpl: failing(() => true, 'ENOTFOUND') }));
  assert.equal(dead.status, 'unreachable');
  assert.equal(dead.error, 'robots.txt: ENOTFOUND');
});

test('menu drawn by JavaScript: /about-us and /contact are found by trying the usual paths', async () => {
  const r = await crawlSite('http://spa.test/', opts());
  assert.equal(r.status, 'crawled');
  assert.deepEqual(r.pages.map((p) => new URL(p.url).pathname).sort(), ['/', '/about-us', '/contact']);
});

test('insecureFetch reads a page whose certificate cannot be verified', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const https = await import('node:https');
  const { insecureFetch, errCode } = await import('./crawl.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch {
    t.skip('openssl not available');
    return;
  }
  const server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>${req.headers['user-agent']}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${server.address().port}/`;
  try {
    const err = await fetch(url).then(() => null, (e) => e);
    assert.match(errCode(err), /SELF_SIGNED|CERT|UNABLE/);
    const res = await insecureFetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const text = await new Response(res.body).text();
    assert.match(text, /NSNExplorerBot/);
  } finally {
    server.close();
  }
});
