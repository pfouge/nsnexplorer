// ingest/supplier-web/extract.mjs
// Dependency-free HTML helpers for the supplier website lane: title / meta description, links,
// readable text (with and without page boilerplate), and the contact details a company publishes
// on its own site (phone, email).

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: '(c)', reg: '(r)', trade: '(tm)', bull: '-', middot: '-' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const collapse = (s) => s.replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = collapse(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '));
  return t ? t.slice(0, 200) : null;
}

function metaContent(html, attr, value) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = new RegExp(`${attr}\\s*=\\s*["']?${value}["']?`, 'i');
    if (!a.test(tag)) continue;
    const c = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = c ? c[1] ?? c[2] ?? c[3] : null;
    if (v) return v;
  }
  return null;
}

/** The site's own <meta name="description"> (og:description as a fallback). */
export function extractMetaDescription(html) {
  const v = metaContent(html, 'name', 'description') ?? metaContent(html, 'property', 'og:description');
  if (!v) return null;
  const t = collapse(decodeEntities(v).replace(/\s+/g, ' '));
  return t ? t.slice(0, 500) : null;
}

/** [{ href (absolute), text }] for every <a href>. */
export function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = h ? decodeEntities(h[1] ?? h[2] ?? h[3]).trim() : '';
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    try {
      out.push({ href: new URL(raw, baseUrl).toString(), text: collapse(decodeEntities(m[2].replace(/<[^>]+>/g, ' '))).slice(0, 120) });
    } catch { /* bad href */ }
  }
  return out;
}

const BLOCK = /^(p|div|br|li|ul|ol|tr|td|th|table|section|article|aside|main|h[1-6]|blockquote|pre|hr|dt|dd|address|form|fieldset|figure|figcaption)$/;
const ALWAYS_SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head']);
const BOILERPLATE = new Set(['nav', 'footer', 'header']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

/**
 * Visible text of a page. Script/style/noscript/svg/template/iframe/head blocks are always dropped;
 * nav/footer/header blocks are dropped too unless keepBoilerplate (contact details often sit there).
 * Block elements become line breaks so words do not run together.
 */
export function extractText(html, { keepBoilerplate = false } = {}) {
  const src = String(html).replace(/<!--[\s\S]*?-->/g, ' ');
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const skip = new Set(ALWAYS_SKIP);
  if (!keepBoilerplate) for (const b of BOILERPLATE) skip.add(b);
  let out = '';
  let last = 0;
  let skipTag = null;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(src))) {
    if (skipTag === null) out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (skipTag !== null) {
      if (name === skipTag) {
        if (!closing && !m[3]) depth += 1;
        else if (closing) {
          depth -= 1;
          if (depth === 0) skipTag = null;
        }
      }
      continue;
    }
    if (!closing && skip.has(name) && !m[3] && !VOID.has(name)) {
      skipTag = name;
      depth = 1;
      continue;
    }
    if (BLOCK.test(name)) out += '\n';
    else if (name === 'img') {
      const alt = /alt\s*=\s*"([^"]{3,80})"/i.exec(m[0]);
      if (alt && keepBoilerplate) out += ` ${alt[1]} `;
    }
  }
  if (skipTag === null) out += src.slice(last);
  return collapse(decodeEntities(out.replace(/<[^>]*>/g, ' ')));
}

export const PAGE_TEXT_CAP = 6000;
export const TOTAL_TEXT_CAP = 16000;

/** Readable text per page, capped at 6,000 chars each and 16,000 in all. */
export function pageTexts(pages) {
  let budget = TOTAL_TEXT_CAP;
  const out = [];
  for (const p of pages) {
    if (budget <= 0) break;
    const text = extractText(p.html).slice(0, Math.min(PAGE_TEXT_CAP, budget));
    budget -= text.length;
    out.push({ url: p.url, title: p.title, text });
  }
  return out;
}

// ---------------------------------------------------------------- contacts

/** US phone -> "(555) 555-0100" (+ " x123"); null when it is not a plausible NANP number. */
export function normalizeUsPhone(raw) {
  let s = String(raw ?? '');
  let ext = '';
  const em = /(?:ext\.?|extension|x|#)\s*(\d{1,6})\s*$/i.exec(s);
  if (em) {
    ext = em[1];
    s = s.slice(0, em.index);
  }
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{2}\d{4}$/.test(d)) return null;
  if (/^(\d)\1{9}$/.test(d)) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}${ext ? ` x${ext}` : ''}`;
}

const PHONE_TEXT = /(?<![\d.-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?(?![\d-])/gi;

/** Phones in page order: tel: links first (they are deliberate), then numbers in the visible text. Fax numbers are skipped. */
export function findPhones(html) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const re = /<a\b[^>]*href\s*=\s*["']?tel:([^"'>\s]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const around = html.slice(Math.max(0, m.index - 40), m.index) + m[2];
    if (/fax/i.test(around.replace(/<[^>]+>/g, ' '))) continue;
    add(normalizeUsPhone(decodeURIComponent(decodeEntities(m[1])).replace(/^\+?/, '')));
  }
  const text = extractText(html, { keepBoilerplate: true });
  let t;
  PHONE_TEXT.lastIndex = 0;
  while ((t = PHONE_TEXT.exec(text))) {
    const before = text.slice(Math.max(0, t.index - 14), t.index);
    if (/fax|f:|\bf\.?\s*$/i.test(before)) continue;
    add(normalizeUsPhone(t[0]));
  }
  return out;
}

const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js', 'ico', 'pdf', 'woff', 'woff2']);
const ROLE_ORDER = ['info', 'sales', 'contact', 'quotes', 'quote', 'rfq', 'orders', 'order', 'support', 'customerservice', 'customer.service', 'cs', 'service', 'inquiries', 'office'];
const BAD_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|abuse|privacy|unsubscribe|mailer-daemon)$/i;

const stripWww = (h) => h.toLowerCase().replace(/^www\./, '');

/** True when `domain` is the site's own domain (or a subdomain / parent of it). */
export function isOwnDomain(domain, siteHosts) {
  const d = stripWww(domain);
  return siteHosts.some((h) => {
    const s = stripWww(h);
    return d === s || d.endsWith(`.${s}`) || s.endsWith(`.${d}`);
  });
}

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}/gi;
// name [at] example [dot] com   /   name (at) example.com   — own domain only (checked by the caller)
const OBFUSCATED = /([a-z0-9][a-z0-9._%+-]{0,63})\s*[[({<]\s*at\s*[\])}>]\s*([a-z0-9-]+(?:\s*(?:[[({<]\s*dot\s*[\])}>]|\.)\s*[a-z0-9-]+)+)/gi;

/** Email addresses on the site's own domain, in page order (mailto: links, then visible text, then obfuscated forms). */
export function findEmails(html, siteHosts) {
  const out = [];
  const add = (e) => {
    const addr = String(e).toLowerCase().replace(/[.,;:]+$/, '');
    const m = /^([^@]+)@(.+)$/.exec(addr);
    if (!m) return;
    const tld = m[2].split('.').pop();
    if (FILE_TLDS.has(tld) || BAD_LOCAL.test(m[1]) || !isOwnDomain(m[2], siteHosts)) return;
    if (!out.includes(addr)) out.push(addr);
  };
  const re = /href\s*=\s*["']?mailto:([^"'>\s?]+)/gi;
  let m;
  while ((m = re.exec(html))) add(decodeURIComponent(decodeEntities(m[1])));
  const text = extractText(html, { keepBoilerplate: true }).replace(/\[\s*@\s*\]|\(\s*@\s*\)/g, '@');
  for (const e of text.match(EMAIL) || []) add(e);
  let o;
  OBFUSCATED.lastIndex = 0;
  while ((o = OBFUSCATED.exec(text))) {
    const domain = o[2].replace(/\s*[[({<]\s*dot\s*[\])}>]\s*/gi, '.').replace(/\s+/g, '');
    add(`${o[1]}@${domain}`);
  }
  return out;
}

/** Prefer role mailboxes (info@, sales@, ...), else the first own-domain address. */
export function pickEmail(emails) {
  for (const role of ROLE_ORDER) {
    const hit = emails.find((e) => e.split('@')[0] === role);
    if (hit) return hit;
  }
  return emails[0] ?? null;
}

/**
 * Phone and email from the crawled pages. Contact pages are read first, then the home page, then the rest.
 * @param {{url: string, category?: string, html: string}[]} pages
 * @param {string[]} siteHosts hostnames that count as the company's own (start URL host, final host)
 * @returns {{ phone: string|null, email: string|null, contactUrl: string|null }}
 */
export function extractContacts(pages, siteHosts) {
  const order = [...pages].sort((a, b) => rank(a) - rank(b));
  function rank(p) {
    return p.category === 'contact' ? 0 : p.category === 'home' ? 1 : 2;
  }
  let phone = null;
  let phoneUrl = null;
  let email = null;
  let emailUrl = null;
  // Pages are read contact page first, then home, then the rest; the first phone and the first email
  // found win, so a role mailbox on the home page never replaces what the contact page itself lists.
  for (const p of order) {
    if (!phone) {
      const ph = findPhones(p.html);
      if (ph.length) { phone = ph[0]; phoneUrl = p.url; }
    }
    if (!email) {
      const em = pickEmail(findEmails(p.html, siteHosts));
      if (em) { email = em; emailUrl = p.url; }
    }
    if (phone && email) break;
  }
  const isContact = (u) => pages.find((p) => p.url === u)?.category === 'contact';
  let contactUrl = null;
  if (phoneUrl && emailUrl) contactUrl = phoneUrl === emailUrl ? phoneUrl : isContact(emailUrl) ? emailUrl : isContact(phoneUrl) ? phoneUrl : emailUrl;
  else contactUrl = phoneUrl ?? emailUrl;
  return { phone, email, contactUrl };
}
