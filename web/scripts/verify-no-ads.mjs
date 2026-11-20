// Checks a built site (web/dist) for the ad-readiness invariants.
// usage: node web/scripts/verify-no-ads.mjs [dist] [--client ca-pub-...]
// The publisher id is read from web/src/lib/ads-config.ts (or --client <id>). With an id: the
// AdSense meta tag and script must appear on the allowed page types only, never on a noindex
// page, after the consent defaults; ads.txt must carry the same id; and while AD_UNITS_ON is
// false no page may contain an ad unit. With an empty id: no file may mention the ad tag and
// ads.txt must not exist. The deploy workflow runs this on every build.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith('--') && !a.startsWith('ca-pub-')) ?? 'web/dist';
const ci = args.indexOf('--client');
const cfg = fs.readFileSync(new URL('../src/lib/ads-config.ts', import.meta.url), 'utf8');
const client = ci >= 0 ? args[ci + 1] : (cfg.match(/ADSENSE_CLIENT = '([^']*)'/)?.[1] ?? '');
const unitsOn = /AD_UNITS_ON = true/.test(cfg);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const html = walk(dist).filter((f) => f.endsWith('.html'));
const rel = (f) => '/' + path.relative(dist, f).replace(/index\.html$/, '').replace(/\.html$/, '').split(path.sep).join('/');
const allowed = (p) => p === '/' || /^\/(guides\/|methodology\/|catalog\/|browse\/|agencies\/|agency\/|group\/|fsc\/)/.test(p);
// Pages that must carry the tag whenever an id is set (Google verifies the site on the home page).
const mustTag = ['/', '/guides/', '/methodology/', '/catalog/'];
const taggedPaths = new Set();
let unitPages = 0;
const fails = [];
let tagged = 0;
for (const f of html) {
  const t = fs.readFileSync(f, 'utf8');
  const has = /adsbygoogle|google-adsense-account|googlesyndication/.test(t);
  const p = rel(f);
  const noindex = /<meta name="robots" content="noindex/.test(t);
  if (!client && has) fails.push(`${p}: ad tag present while ADSENSE_CLIENT is empty`);
  if (client) {
    if (has) { tagged++; taggedPaths.add(p); }
    if (has && !(t.includes(`<meta name="google-adsense-account" content="${client}"`) && t.includes(`adsbygoogle.js?client=${client}`))) fails.push(`${p}: needs both the meta tag and the script`);
    if (has && !(t.indexOf("'consent'") >= 0 && t.indexOf("'consent'") < t.indexOf('google-adsense-account'))) fails.push(`${p}: consent defaults must come before the AdSense tag`);
    const units = t.match(/<aside class="ad-unit[^>]*>[\s\S]*?<\/aside>/g) ?? [];
    const insCount = (t.match(/<ins[^>]*class="[^"]*adsbygoogle/g) ?? []).length;
    if (!unitsOn && insCount) fails.push(`${p}: ad unit present while AD_UNITS_ON is false`);
    if (insCount !== units.length) fails.push(`${p}: an <ins> outside the AdUnit wrapper`);
    if (units.length && !has) fails.push(`${p}: ad unit on a page that does not load the ad script`);
    if (units.length > 4) fails.push(`${p}: ${units.length} ad units (max 4)`);
    if (units.length) unitPages++;
    for (const u of units) {
      if (!/<p class="ad-label"[^>]*>Advertisements<\/p>/.test(u)) fails.push(`${p}: ad label is not exactly "Advertisements"`);
      if (!u.includes(`data-ad-client="${client}"`) || !/data-ad-slot="\d{10}"/.test(u)) fails.push(`${p}: ad unit without client or slot`);
    }
    for (const m of t.matchAll(/<table[\s\S]*?<\/table>/g)) if (m[0].includes('class="ad-unit')) fails.push(`${p}: ad unit inside a table`);
    if (unitsOn && has && !units.some((u) => u.includes('ad-unit--top'))) fails.push(`${p}: tagged page without the top unit`);
    if (t.includes('pub-' + '7904' + '1739' + '8827' + '1272')) fails.push(`${p}: wrong publisher id`);
    if (has && !allowed(p)) fails.push(`${p}: ad tag on a page type that must not carry ads`);
    if (has && noindex) fails.push(`${p}: ad tag on a noindex page`);
    if (has && !t.includes(client)) fails.push(`${p}: tag without the configured client`);
  }
  // Consent Mode defaults must come before the analytics loader, and gtag('config') appears once.
  if (!f.includes(`${path.sep}embed${path.sep}`) && !/^\/(404|api)/.test(p) && /gtag\/js/.test(t)) {
    const d = t.indexOf("'consent'"), g = t.indexOf('gtag/js');
    if (!(d >= 0 && d < g)) fails.push(`${p}: consent defaults missing or after the tag`);
    if ((t.match(/gtag\('config'/g) ?? []).length !== 1) fails.push(`${p}: expected exactly one gtag config call`);
  }
}
const adsTxt = path.join(dist, 'ads.txt');
if (!client && fs.existsSync(adsTxt)) fails.push('ads.txt exists while the id is empty');
if (client) {
  const want = `google.com, ${client.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0`;
  if (!fs.existsSync(adsTxt) || fs.readFileSync(adsTxt, 'utf8').trim() !== want) fails.push('ads.txt missing or not the expected line');
  for (const p of mustTag) if (!taggedPaths.has(p)) fails.push(`${p}: expected the AdSense tag`);
}
const sm = walk(dist).filter((f) => /sitemap.*\.xml$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
if (!sm.includes('https://nsnexplorer.com/contact/')) fails.push('contact page missing from the sitemap');
const llms = path.join(dist, 'llms.txt');
if (fs.existsSync(llms) && !fs.readFileSync(llms, 'utf8').includes('/contact/')) fails.push('contact page missing from llms.txt');
// No sitemap may list a page that is noindex, and the pages Google's reviewers look for exist.
for (const loc of [...sm.matchAll(/<loc>https:\/\/nsnexplorer\.com(\/[^<]*)<\/loc>/g)].map((m) => m[1])) {
  const page = path.join(dist, decodeURIComponent(loc), 'index.html');
  if (fs.existsSync(page) && /<meta name="robots" content="noindex/.test(fs.readFileSync(page, 'utf8').slice(0, 20000))) fails.push(`${loc}: noindex page listed in the sitemap`);
}
for (const p of ['about', 'contact', 'privacy', 'terms']) if (!fs.existsSync(path.join(dist, p, 'index.html'))) fails.push(`/${p}/ not built`);
if (!fs.existsSync(path.join(dist, '404.html'))) fails.push('404 page not built');
const contact = path.join(dist, 'contact', 'index.html');
if (!fs.existsSync(contact)) fails.push('contact page not built');
for (const f of html) {
  const t = fs.readFileSync(f, 'utf8');
  if (/<footer class="site"/.test(t) && !/<footer[\s\S]*href="\/contact\/"[\s\S]*<\/footer>/.test(t)) fails.push(`${rel(f)}: footer lacks the Contact link`);
}
if (client && unitsOn) {
  // the in-page units really render (they once vanished into a named slot)
  const expect = { 'methodology/index.html': ['article', 'low'], 'catalog/index.html': ['mid'], 'guides/what-is-an-nsn/index.html': ['article'], 'index.html': ['mid'] };
  for (const [f, kinds] of Object.entries(expect)) {
    const t = fs.existsSync(path.join(dist, f)) ? fs.readFileSync(path.join(dist, f), 'utf8') : '';
    for (const k of kinds) if (!t.includes(`ad-unit--${k}`)) fails.push(`/${f}: expected the ${k} unit`);
  }
}
if (client && unitsOn && unitPages !== tagged) fails.push(`units on ${unitPages} pages but the ad tag on ${tagged}`);
console.log(`checked ${html.length} html files; ad tag on ${tagged}; ad units on ${unitPages}; ${fails.length} problems`);
for (const x of fails.slice(0, 40)) console.log('FAIL', x);
process.exit(fails.length ? 1 : 0);
