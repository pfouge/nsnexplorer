import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adsEnabled, ADSENSE_CLIENT_RE } from './ads.ts';
import { ADSENSE_CLIENT, AD_UNITS_ON, AD_SLOTS } from './ads-config.ts';
import { CONSENT_COUNTRIES, consentRequired } from './consent.ts';
import { SITE_CSP, EMBED_CSP } from './csp.ts';

const src = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
// A made-up id for the logic tests only (never a real publisher id): "ca-pub-" and sixteen digits.
const FAKE = 'ca-pub-' + '1234567890'.repeat(2).slice(0, 16);

// The network publisher id that must never be used on this site, split so this file's own
// text does not match a search for it.
const FORBIDDEN = 'pub-' + '7904' + '1739' + '8827' + '1272';

test('the switch file holds the one publisher id; BaseLayout imports it; units are off', () => {
  assert.ok(ADSENSE_CLIENT_RE.test(ADSENSE_CLIENT));
  assert.notEqual(ADSENSE_CLIENT, 'ca-' + FORBIDDEN);
  assert.equal(AD_UNITS_ON, false, 'phase 1: no in-page units');
  assert.deepEqual(Object.keys(AD_SLOTS), ['top', 'mid', 'low', 'article', 'multiplex']);
  for (const v of Object.values(AD_SLOTS)) assert.equal(v, '', 'slot ids are filled in phase 2');
  const layout = src('layouts/BaseLayout.astro');
  assert.match(layout, /import \{ ADSENSE_CLIENT \} from '\.\.\/lib\/ads-config';/);
  assert.doesNotMatch(layout, /const ADSENSE_CLIENT/);
});

test('ads.txt is the one authorised-seller line for the same publisher id', () => {
  const txt = fs.readFileSync(new URL('../../public/ads.txt', import.meta.url), 'utf8');
  assert.equal(txt, `google.com, ${ADSENSE_CLIENT.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);
});

test('an empty or malformed client never enables ads, whatever the page says', () => {
  for (const client of ['', 'pub-1234567890123456', 'ca-pub-123', 'ca-pub-12345678901234567', ' ' + FAKE]) {
    for (const prod of [true, false]) for (const ads of [true, false]) for (const noindex of [false, true, 'follow'] as const) {
      assert.equal(adsEnabled({ client, prod, ads, noindex }), false);
    }
  }
  assert.ok(ADSENSE_CLIENT_RE.test(FAKE));
});

test('with an id: production only, opted-in pages only, never noindex', () => {
  assert.equal(adsEnabled({ client: FAKE, prod: true, ads: true, noindex: false }), true);
  assert.equal(adsEnabled({ client: FAKE, prod: true, ads: true, noindex: undefined }), true);
  assert.equal(adsEnabled({ client: FAKE, prod: false, ads: true, noindex: false }), false);
  assert.equal(adsEnabled({ client: FAKE, prod: true, ads: false, noindex: false }), false);
  assert.equal(adsEnabled({ client: FAKE, prod: true, ads: true, noindex: true }), false);
  assert.equal(adsEnabled({ client: FAKE, prod: true, ads: true, noindex: 'follow' }), false);
});

test('the ads prop defaults to false in BaseLayout', () => {
  assert.match(src('layouts/BaseLayout.astro'), /const \{ tape = false, ads = false,/);
});

test('only the allowed page types pass ads, and each of them does', () => {
  const pagesDir = new URL('../pages/', import.meta.url).pathname;
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const withAds = walk(pagesDir)
    .filter((f) => f.endsWith('.astro'))
    .filter((f) => /<BaseLayout[^>]*\bads=/s.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(pagesDir, f).split(path.sep).join('/'))
    .sort();
  const guides = fs.readdirSync(path.join(pagesDir, 'guides')).filter((f) => f.endsWith('.astro')).map((f) => `guides/${f}`);
  const expected = [
    'index.astro', ...guides, 'methodology.astro', 'catalog.astro', 'browse.astro', 'group/[fsg].astro', 'fsc/[fsc]/[...page].astro',
    'agencies.astro', 'agency/[slug].astro',
  ].sort();
  assert.deepEqual(withAds, expected);
  // a page passing a plain `true` must be a static content page; listing pages tie it to having content
  for (const f of withAds.filter((f) => !f.startsWith('guides/') && f !== 'methodology.astro' && f !== 'index.astro')) {
    assert.doesNotMatch(fs.readFileSync(path.join(pagesDir, f), 'utf8'), /<BaseLayout[^>]*\bads=\{true\}/s, `${f} must not show ads on an empty state`);
  }
});

test('the publisher id appears only in the switch file and ads.txt, and the network id nowhere', () => {
  const roots = [new URL('../', import.meta.url).pathname, new URL('../../public/', import.meta.url).pathname];
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const own = ADSENSE_CLIENT.replace(/^ca-/, '');
  for (const f of roots.flatMap(walk)) {
    if (!/\.(astro|ts|mjs|js|txt|json|css|html|md)$/.test(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes(FORBIDDEN), `${f} contains the network publisher id`);
    const ids = t.match(/pub-\d{16}/g) ?? [];
    if (f.endsWith(`lib${path.sep}ads-config.ts`) || f.endsWith(`public${path.sep}ads.txt`)) assert.deepEqual([...new Set(ids)], [own], f);
    else if (!f.endsWith('ads.test.ts')) assert.deepEqual(ids, [], `${f} contains a publisher id`);
  }
});

test('CSP opens every fetch directive to https: and keeps the injection and framing guards', () => {
  for (const csp of [SITE_CSP, EMBED_CSP]) {
    const d = Object.fromEntries(csp.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v]; }));
    for (const k of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'frame-src', 'media-src']) assert.ok(d[k]?.includes('https:'), `${k} allows https:`);
    assert.ok(d['script-src'].includes("'unsafe-inline'") && d['script-src'].includes("'unsafe-eval'"));
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.deepEqual(d['base-uri'], ["'self'"]);
    assert.ok(d['form-action'].includes("'self'"));
    assert.ok(d['frame-ancestors']);
    assert.ok('upgrade-insecure-requests' in d);
  }
});

test('consent regions: 27 EU states plus IS, LI, NO, GB, CH, shared with /api/region.json', () => {
  const eu = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
  assert.equal(eu.length, 27);
  assert.deepEqual([...CONSENT_COUNTRIES].sort(), [...eu, 'IS', 'LI', 'NO', 'GB', 'CH'].sort());
  assert.ok(consentRequired('DE') && consentRequired('gb') && consentRequired(null) && consentRequired('XX'));
  assert.ok(!consentRequired('US') && !consentRequired('SG'));
  assert.match(src('pages/api/region.json.ts'), /from '..\/..\/lib\/consent'/);
});

test('Consent Mode v2 defaults sit above every Google tag: ad signals denied everywhere, all four in the consent regions', () => {
  const layout = src('layouts/BaseLayout.astro');
  const def = layout.indexOf("gtag('consent', 'default'");
  const def2 = layout.indexOf("gtag('consent', 'default'", def + 1);
  assert.ok(def > 0 && def2 > def);
  assert.equal(layout.match(/gtag\('consent', 'default'/g)?.length, 2);
  for (const marker of ['googletagmanager.com/gtag/js', 'adsbygoogle.js', 'google-adsense-account', "gtag('config'"]) assert.ok(layout.indexOf(marker) > def2, `${marker} comes after the defaults`);
  // 1: worldwide, no region key, the three advertising signals denied, analytics untouched
  const world = layout.slice(def, layout.indexOf('});', def));
  for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization']) assert.match(world, new RegExp(`${k}: 'denied'`));
  assert.doesNotMatch(world, /region|analytics_storage|granted/);
  // 2: the consent regions, all four denied
  const block = layout.slice(def2, layout.indexOf('});', def2));
  for (const k of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) assert.match(block, new RegExp(`${k}: 'denied'`));
  assert.match(block, /region: CONSENT_REGIONS/);
  assert.match(block, /wait_for_update: 500/);
  // nothing grants an advertising signal anywhere in the layout
  assert.doesNotMatch(layout, /ad_(storage|user_data|personalization): 'granted'/);
  // exactly one config call: one page view per page
  assert.equal(layout.match(/gtag\('config'/g)?.length, 1);
});

test('the privacy page says what is true in phase 1', () => {
  const p = src('pages/privacy.astro');
  assert.match(p, /No advertising is shown on the Services today/);
  assert.match(p, /No advertising cookies are set/);
  assert.match(p, /policies\.google\.com\/technologies\/partner-sites/);
});

test('footer links About, Contact, Terms and Privacy; the contact page uses the address constant and has no em dash', () => {
  const layout = src('layouts/BaseLayout.astro');
  for (const h of ['/about/', '/contact/', '/terms/', '/privacy/']) assert.ok(layout.includes(`<a href="${h}">`));
  const contact = src('pages/contact.astro');
  assert.match(contact, /CONTACT_EMAIL/);
  assert.match(contact, /NAO Parts LLC/);
  assert.ok(!contact.includes('—'));
  assert.ok(src('pages/llms.txt.ts').includes('/contact/'));
});
