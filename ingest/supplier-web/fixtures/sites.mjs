// Fixture web for the supplier-web tests and the local end-to-end run: one http server that plays many
// company websites (chosen by the x-virtual-host header) and a mock Anthropic Messages endpoint.
import http from 'node:http';

const page = (title, body, { meta = '', head = '' } = {}) =>
  `<!doctype html><html><head><title>${title}</title>${meta}${head}<style>.x{color:red}</style></head><body>${body}</body></html>`;

const NAV = '<nav><a href="/">Home</a> <a href="/careers">Careers</a> <a href="/about">About</a></nav>';
const BIG_TEXT = 'Precision machined components for defense and aerospace programs. ';

export const SITES = {
  // The well-behaved site: home, about, products, contact, quality; a footer with a web designer's address.
  'acme-parts.test': {
    pages: {
      '/': page('ACME Fasteners - Home',
        `<header><h1>ACME HEADER BOILERPLATE</h1></header>${NAV}
         <main><p>Welcome to ACME Fasteners, a family-owned machine shop in Dayton, Ohio. We turn, mill and finish fasteners and fittings for military and commercial customers.</p>
         <p><a href="/about-us">About us</a> | <a href="/products-and-services">Products &amp; services</a> | <a href="/contact-us">Contact</a> | <a href="/quality">Quality</a> | <a href="/files/catalog.pdf">Catalog</a> | <a href="https://other.example/contact">Elsewhere</a></p></main>
         <footer>Site by <a href="mailto:designer@webshop.io">designer@webshop.io</a> FOOTER BOILERPLATE</footer>`,
        { meta: '<meta name="description" content="Family-owned fastener &amp; fitting machine shop in Dayton, Ohio.">' }),
      '/about-us': page('About ACME', '<main><h2>Our story</h2><p>ACME was founded in 1987 by two machinists who wanted to build better hardware for the Air Force. Today about forty people run CNC lathes and mills on two shifts.</p></main>'),
      '/products-and-services': page('Products', '<main><ul><li>Hex bolts and cap screws</li><li>Custom threaded inserts</li><li>CNC turning and milling</li><li>Passivation and anodizing</li></ul></main>'),
      '/quality': page('Quality', '<main><p>We are ISO 9001:2015 and AS9100D certified and registered with ITAR.</p></main>'),
      '/contact-us': page('Contact ACME',
        `<main><h2>Contact us</h2><p>Phone: <a href="tel:+19375550142">937-555-0142</a><br>Fax: (937) 555-0199</p>
         <p>Email <a href="mailto:Sales@Acme-Parts.test?subject=Quote">our sales desk</a> or accounting@acme-parts.test.</p>
         <p>Web design by <a href="mailto:hello@pixelstudio.io">hello@pixelstudio.io</a></p></main>`),
      '/careers': page('Careers', '<main>Join us</main>'),
    },
  },
  // Disallows everything: nothing but robots.txt may be requested.
  'blocked.test': { robots: 'User-agent: *\nDisallow: /\n', pages: { '/': page('Blocked', '<p>Secret</p>') } },
  // Disallows only /contact; named group for our bot allows more specifically than "*".
  'partial.test': {
    robots: 'User-agent: *\nDisallow: /\n\nUser-agent: NSNExplorerBot\nDisallow: /contact\nAllow: /contact-sales-not\n',
    pages: {
      '/': page('Partial', `<main><p>${BIG_TEXT.repeat(5)}</p><a href="/contact">Contact</a> <a href="/about">About</a></main>`),
      '/about': page('About partial', `<main><p>${BIG_TEXT.repeat(3)} Since 1999.</p></main>`),
      '/contact': page('Contact partial', '<p>Call 555-555-0111</p>'),
    },
  },
  // Answers after 400 ms; the tests use a 100 ms timeout.
  'slow.test': { delayMs: 400, pages: { '/': page('Slow', `<p>${BIG_TEXT.repeat(5)}</p>`) } },
  // Three-hop redirect chain, ending on a real page with a canonical host change (www).
  'redirect.test': {
    redirects: { '/': '/step1', '/step1': '/step2', '/step2': 'http://www.redirect.test/home' },
    pages: {},
  },
  'www.redirect.test': {
    pages: { '/home': page('Redirect landed', `<main><p>${BIG_TEXT.repeat(5)}</p><p>Email info@redirect.test</p></main>`) },
  },
  // Redirects forever.
  'loop.test': { redirects: { '/': '/a', '/a': '/b', '/b': '/c', '/c': '/d', '/d': '/e', '/e': '/f', '/f': '/g', '/g': '/' }, pages: {} },
  // Not HTML at all.
  'pdf.test': { contentType: 'application/pdf', pages: { '/': '%PDF-1.4 binary' } },
  // Obfuscated own-domain address, plus an obfuscated third-party one that must be dropped.
  'obfus.test': {
    pages: {
      '/': page('Obfus', `<main><p>${BIG_TEXT.repeat(4)}</p><a href="/contact">Contact</a></main>`),
      '/contact': page('Contact', '<main><p>Orders: sales [at] obfus [dot] test &mdash; or bob (at) gmail (dot) com. Call (330) 555-0177 ext. 22.</p></main>'),
    },
  },
  // A page that is only a script shell.
  'thin.test': {
    pages: { '/': page('App', '<div id="root"></div><script>render()</script><a href="tel:3305550188">call</a>', { meta: '<meta name="description" content="Single page app shell.">' }) },
  },
  'gone.test': { status: 404, pages: {} },
  'robots500.test': { robots: 500, pages: { '/': page('x', `<p>${BIG_TEXT.repeat(5)}</p>`) } },
  // A 2 MB home page: only the first 1.5 MB is read.
  'big.test': { pages: { '/': page('Big', `<main><p>${BIG_TEXT.repeat(2)}</p>${'<p>filler filler filler filler filler filler</p>'.repeat(50000)}</main>`) } },
};

/** Starts the fixture web. @returns {{ port: number, log: {host: string, url: string, at: number, ua: string}[], close: () => Promise<void> }} */
export async function startFixtureSites(sites = SITES, port = 0) {
  const log = [];
  const server = http.createServer((req, res) => {
    const host = String(req.headers['x-virtual-host'] || '').toLowerCase();
    log.push({ host, url: req.url, at: Date.now(), ua: String(req.headers['user-agent'] || '') });
    const site = sites[host];
    if (!site) { res.writeHead(502); res.end('no such site'); return; }
    const send = () => {
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/robots.txt') {
        if (site.robots === 500) { res.writeHead(500); res.end('boom'); return; }
        if (typeof site.robots === 'string') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(site.robots); return; }
        res.writeHead(404); res.end('not found'); return;
      }
      if (site.status) { res.writeHead(site.status); res.end('nope'); return; }
      if (site.redirects?.[p]) {
        const to = site.redirects[p];
        res.writeHead(p === '/' ? 301 : 302, { location: to });
        res.end();
        return;
      }
      const body = site.pages[p];
      if (body === undefined) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
      res.writeHead(200, { 'content-type': site.contentType || 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (site.delayMs && req.url !== '/robots.txt') setTimeout(send, site.delayMs); else send();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** fetch() that sends every *.test request to the fixture server, as if DNS pointed there. */
export function virtualFetch(port, realFetch = globalThis.fetch) {
  return (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (!u.hostname.endsWith('.test')) return realFetch(input, init);
    const headers = { ...(init.headers || {}), 'x-virtual-host': u.hostname };
    return realFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers });
  };
}

// ---------------------------------------------------------------- mock Anthropic

const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

/**
 * Mock POST /v1/messages. The reply depends on the company name in the prompt:
 *   BADCO  -> 130-word summary (must be rejected)      COPYCO -> copies a long run of the site text
 *   OLDCO  -> founded 1066 (must be rejected)          NOTOOL -> text answer, no tool call
 *   BUSY   -> 529 twice, then fine                      NOKEY  -> 401
 * Everything else gets a valid profile. Requests are validated and recorded in `calls`.
 */
export async function startMockAnthropic(port = 0) {
  const calls = [];
  const busy = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const user = body.messages?.[0]?.content || '';
    const name = /Company name on record: (.*)/.exec(user)?.[1]?.trim() || '';
    calls.push({ url: req.url, headers: req.headers, body, name });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url !== '/v1/messages' || req.method !== 'POST') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } });
    if (name.includes('NOKEY')) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (name.includes('BUSY')) {
      const n = (busy.get(name) || 0) + 1;
      busy.set(name, n);
      if (n <= 2) return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    }
    const tool = (input) => json(200, { id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'record_profile', input }] });
    if (name.includes('NOTOOL')) return json(200, { id: 'msg_x', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry.' }] });
    if (name.includes('BADCO')) return tool({ summary: words(130), products: [], capabilities: [], certifications: [], founded: null });
    if (name.includes('OLDCO')) return tool({ summary: 'A small shop.', products: ['Bolts'], capabilities: [], certifications: [], founded: 1066 });
    if (name.includes('COPYCO')) {
      const m = /(ACME was founded in 1987 by two machinists who wanted to build better hardware for the Air Force)/.exec(user);
      return tool({ summary: `Notes: ${m ? m[1] : 'x'} and more words follow here.`, products: [], capabilities: [], certifications: [], founded: null });
    }
    return tool({
      summary: 'Dayton-based machine shop that turns and mills fasteners and threaded fittings for defense and commercial buyers, with finishing handled in house.',
      products: ['Hex bolts', 'Cap screws', 'Threaded inserts'],
      capabilities: ['CNC turning', 'CNC milling', 'Passivation', 'Anodizing'],
      certifications: ['ISO 9001:2015', 'AS9100D', 'ITAR registered'],
      founded: 1987,
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, baseUrl: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
