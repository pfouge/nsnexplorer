// Checks a built site (web/dist) for the ad-readiness invariants.
// usage: node web/scripts/verify-no-ads.mjs [dist] [--client ca-pub-...]
// Default: ADSENSE_CLIENT is empty, so NO file may mention the ad tag, the AdSense meta or
// googlesyndication, and public/ads.txt must not exist. With --client <id> (only for testing a
// build that had an id filled in): the tag must appear on exactly the allowed page types.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith('--') && !a.startsWith('ca-pub-')) ?? 'web/dist';
const ci = args.indexOf('--client');
const client = ci >= 0 ? args[ci + 1] : '';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const html = walk(dist).filter((f) => f.endsWith('.html'));
const rel = (f) => '/' + path.relative(dist, f).replace(/index\.html$/, '').replace(/\.html$/, '').split(path.sep).join('/');
const allowed = (p) => /^\/(guides\/|methodology\/|catalog\/|browse\/|agencies\/|agency\/|group\/|fsc\/)/.test(p);
const fails = [];
let tagged = 0;
for (const f of html) {
  const t = fs.readFileSync(f, 'utf8');
  const has = /adsbygoogle|google-adsense-account|googlesyndication/.test(t);
  const p = rel(f);
  const noindex = /<meta name="robots" content="noindex/.test(t);
  if (!client && has) fails.push(`${p}: ad tag present while ADSENSE_CLIENT is empty`);
  if (client) {
    if (has) tagged++;
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
if (fs.existsSync(path.join(dist, 'ads.txt'))) fails.push('ads.txt exists');
const sm = walk(dist).filter((f) => /sitemap.*\.xml$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
if (!sm.includes('https://nsnexplorer.com/contact/')) fails.push('contact page missing from the sitemap');
const llms = path.join(dist, 'llms.txt');
if (fs.existsSync(llms) && !fs.readFileSync(llms, 'utf8').includes('/contact/')) fails.push('contact page missing from llms.txt');
const contact = path.join(dist, 'contact', 'index.html');
if (!fs.existsSync(contact)) fails.push('contact page not built');
for (const f of html) {
  const t = fs.readFileSync(f, 'utf8');
  if (/<footer class="site"/.test(t) && !/<footer[\s\S]*href="\/contact\/"[\s\S]*<\/footer>/.test(t)) fails.push(`${rel(f)}: footer lacks the Contact link`);
}
console.log(`checked ${html.length} html files; ad tag on ${tagged}; ${fails.length} problems`);
for (const x of fails.slice(0, 40)) console.log('FAIL', x);
process.exit(fails.length ? 1 : 0);
