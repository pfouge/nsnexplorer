// node:test suite for extract.mjs (text, meta, phones, emails, contact choice).
// Run: node --test ingest/supplier-web/extract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractTitle, extractMetaDescription, extractLinks, normalizeUsPhone, findPhones, findEmails, pickEmail, extractContacts, pageTexts, TOTAL_TEXT_CAP, PAGE_TEXT_CAP } from './extract.mjs';
import { SITES } from './fixtures/sites.mjs';

test('extractText drops script/style/noscript/svg and nav/footer/header, keeps block breaks', () => {
  const html = '<header>HEAD</header><nav>MENU<nav>inner</nav>tail</nav><main><h1>Title</h1><p>Hello &amp; <b>welcome</b></p><script>var x="<p>no</p>"</script><style>p{}</style><svg><text>icon</text></svg><noscript>enable js</noscript><p>Second&nbsp;para</p></main><footer>FOOT</footer>';
  assert.equal(extractText(html), 'Title\nHello & welcome\nSecond para');
  assert.match(extractText(html, { keepBoilerplate: true }), /HEAD[\s\S]*MENU[\s\S]*FOOT/);
  assert.equal(extractText('plain text only'), 'plain text only');
  assert.equal(extractText('<p>unclosed <nav>never closed'), 'unclosed');
});

test('title, meta description, links', () => {
  const html = '<title> A &amp; B \n Co </title><meta name="description" content="Makes &quot;things&quot;"><a href="/x?a=1&amp;b=2">X <b>link</b></a><a href="mailto:a@b.co">m</a><a href="#top">t</a>';
  assert.equal(extractTitle(html), 'A & B Co');
  assert.equal(extractMetaDescription(html), 'Makes "things"');
  assert.deepEqual(extractLinks(html, 'https://s.test/p/'), [{ href: 'https://s.test/x?a=1&b=2', text: 'X link' }]);
  assert.equal(extractMetaDescription('<meta property="og:description" content="OG text">'), 'OG text');
  assert.equal(extractMetaDescription('<p>none</p>'), null);
});

test('phone normalisation to (555) 555-0100 with extension; bad numbers rejected', () => {
  assert.equal(normalizeUsPhone('937-555-0142'), '(937) 555-0142');
  assert.equal(normalizeUsPhone('+1 (937) 555.0142'), '(937) 555-0142');
  assert.equal(normalizeUsPhone('1-800-555-0100 ext. 45'), '(800) 555-0100 x45');
  assert.equal(normalizeUsPhone('937 555 0142 x7'), '(937) 555-0142 x7');
  assert.equal(normalizeUsPhone('123-456-7890'), null); // area code cannot start with 1
  assert.equal(normalizeUsPhone('000-000-0000'), null);
  assert.equal(normalizeUsPhone('555-0100'), null);
  assert.equal(normalizeUsPhone('+44 20 7946 0958'), null);
});

test('findPhones: tel: links first, fax numbers and long digit runs skipped', () => {
  const html = '<p>Fax: (937) 555-0199</p><p>Order #5555550123456</p><a href="tel:+19375550142">call</a> <p>Office 330.555.0177 ext 22 | F: 330-555-0178</p>';
  assert.deepEqual(findPhones(html), ['(937) 555-0142', '(330) 555-0177 x22']);
});

test('findEmails: own domain only, mailto and text and [at]/[dot] forms, no images or noreply', () => {
  const html = `<a href="mailto:Sales@Acme-Parts.test?subject=x">s</a> Write info@acme-parts.test. designer@webshop.io
    <img src="logo@2x.png"> noreply@acme-parts.test Bob (at) gmail (dot) com  orders [at] acme-parts [dot] test`;
  assert.deepEqual(findEmails(html, ['www.acme-parts.test']), ['sales@acme-parts.test', 'info@acme-parts.test', 'orders@acme-parts.test']);
  assert.deepEqual(findEmails('mail bob@sub.example.com', ['example.com']), ['bob@sub.example.com']);
  assert.deepEqual(findEmails('mail bob@example.org', ['example.com']), []);
});

test('pickEmail prefers role mailboxes in the documented order', () => {
  assert.equal(pickEmail(['jane@x.com', 'orders@x.com', 'sales@x.com', 'info@x.com']), 'info@x.com');
  assert.equal(pickEmail(['jane@x.com', 'orders@x.com', 'sales@x.com']), 'sales@x.com');
  assert.equal(pickEmail(['jane@x.com', 'bob@x.com']), 'jane@x.com');
  assert.equal(pickEmail([]), null);
});

test('extractContacts on the fixture site: contact page wins, third-party addresses ignored', () => {
  const S = SITES['acme-parts.test'].pages;
  const pages = [
    { url: 'http://acme-parts.test/', category: 'home', html: S['/'] },
    { url: 'http://acme-parts.test/contact-us', category: 'contact', html: S['/contact-us'] },
    { url: 'http://acme-parts.test/about-us', category: 'about', html: S['/about-us'] },
  ];
  const c = extractContacts(pages, ['acme-parts.test']);
  assert.equal(c.phone, '(937) 555-0142');
  assert.equal(c.email, 'sales@acme-parts.test'); // sales beats accounting; designer@webshop.io and hello@pixelstudio.io ignored
  assert.equal(c.contactUrl, 'http://acme-parts.test/contact-us');
  assert.deepEqual(extractContacts([{ url: 'u', category: 'home', html: '<p>nothing</p>' }], ['x.test']), { phone: null, email: null, contactUrl: null });
});

test('pageTexts caps 6,000 chars per page and 16,000 in all', () => {
  const big = `<p>${'word '.repeat(5000)}</p>`;
  const t = pageTexts([1, 2, 3, 4].map((i) => ({ url: `u${i}`, title: null, html: big })));
  assert.equal(t[0].text.length, PAGE_TEXT_CAP);
  assert.equal(t.reduce((n, x) => n + x.text.length, 0), TOTAL_TEXT_CAP);
  assert.equal(t.length, 3);
});
