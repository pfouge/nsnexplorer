// verify-seo.mjs: fetch each top-level page of nsnexplorer.com and check
// title text/length, description length, exactly one H1, JSON-LD @types,
// and that counts render as numbers rather than 0 or "undefined".
// Usage: node docs/verify-seo.mjs [https://base.url]
const base = (process.argv[2] ?? 'https://nsnexplorer.com').replace(/\/$/, '');
const pages = ['/', '/open/', '/catalog/', '/suppliers/', '/browse/', '/agencies/', '/methodology/', '/about/'];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

let failures = 0;
const fail = (msg) => { failures += 1; console.log('   FAIL ' + msg); };

for (const p of pages) {
  const url = base + p;
  const res = await fetch(url, { headers: { 'user-agent': 'verify-seo' } });
  const html = await res.text();
  console.log(`\n${p}  (${res.status})`);
  if (res.status !== 200) { fail(`status ${res.status}`); continue; }

  const title = strip(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => strip(m[1]));
  const types = new Set();
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o['@type']) types.add(o['@type']); Object.values(o).forEach(walk); } };
      walk(j);
    } catch { fail('unparseable JSON-LD block'); }
  }

  console.log(`   title (${title.length}): ${title}`);
  console.log(`   desc  (${desc.length}): ${desc}`);
  console.log(`   h1 x${h1s.length}: ${h1s.join(' | ')}`);
  console.log(`   ld+json: ${[...types].join(', ')}`);

  if (!title) fail('missing title');
  if (title.length > 70) fail('title over 70 chars including site suffix');
  if (desc.length < 140 || desc.length > 160) fail(`description length ${desc.length} outside 140-160`);
  if (h1s.length !== 1) fail(`expected exactly one H1, found ${h1s.length}`);
  for (const t of ['BreadcrumbList']) if (!types.has(t)) fail(`missing ${t}`);
  if (p !== '/about/' && !types.has('FAQPage')) fail('missing FAQPage');
  const head = title + ' ' + desc + ' ' + h1s.join(' ');
  if (/undefined|NaN|\b0 (open|national|FSC|federal|agencies)/i.test(head)) fail('zero/undefined count in title, description or H1');
  if (/[—]/.test(head)) fail('em-dash in title, description or H1');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
