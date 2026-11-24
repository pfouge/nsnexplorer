// Adds heavy and sparse examples of every page type to the visual-regression route list, so layouts
// are judged on the longest and the emptiest real pages. usage: node extra-routes.mjs <base_url> <routes_in> <routes_out>
// env DATABASE_URL (the local snapshot).
import fs from 'node:fs';
import pg from 'pg';

const [base, inFile, outFile] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const q = async (sql) => { try { return (await pool.query(sql)).rows; } catch (e) { console.log('query failed', e.message); return []; } };
const get = async (p) => { try { const r = await fetch(base + p); return r.ok ? await r.text() : null; } catch { return null; } };
const firstOk = async (c) => { for (const x of c) if (x && await get(x)) return x; return null; };
const fmt = (n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9)}`;
const out = fs.readFileSync(inFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const add = (r, why) => { if (r && !out.includes(r)) { out.push(r); console.log('route', r, why); } else if (!r) console.log('MISSING', why); };

// Heaviest part: most solicitations plus price points. Sparse part: neither.
const heavy = await q(`select nsn from (select nsn, count(*) c from pub.solicitations where nsn is not null group by nsn order by c desc limit 5) s`);
add(await firstOk(heavy.map((r) => `/nsn/${fmt(r.nsn.trim())}/`)), 'heaviest part');
const sparse = await q(`select n.nsn from pub.nsns n where not exists (select 1 from pub.solicitations s where s.nsn=n.nsn)
  and not exists (select 1 from pub.price_points p where p.nsn=n.nsn) order by n.nsn limit 5`);
add(await firstOk(sparse.map((r) => `/nsn/${fmt(r.nsn.trim())}/`)), 'sparse part');
// Sparse solicitation (no NSN, e.g. a SAM.gov notice) and a services notice.
const samSol = await q(`select sol_number from pub.solicitations where nsn is null and status='open' order by sol_number limit 5`);
add(await firstOk(samSol.map((r) => `/solicitation/${encodeURIComponent(r.sol_number)}/`)), 'solicitation without part');
// Supplier with very little activity.
const smallSup = await q(`select cage from pub.suppliers s where exists (select 1 from pub.part_numbers p where p.cage=s.cage) order by cage limit 20`);
add(await firstOk(smallSup.map((r) => `/supplier/${r.cage.trim()}/`)), 'sparse supplier');
// Guides, a services category, agency pages, class page 2, watchlist.
const guides = [...new Set([...((await get('/guides/')) ?? '').matchAll(/href="(\/guides\/[a-z0-9-]+\/)"/g)].map((m) => m[1]))];
guides.forEach((g) => add(g, 'guide'));
const svc = ((await get('/services/')) ?? '').match(/href="(\/services\/[^"\/]+\/)"/);
add(svc?.[1] ?? null, 'services category');
const ags = [...new Set([...((await get('/agencies/')) ?? '').matchAll(/href="(\/agency\/[^"]+\/)"/g)].map((m) => m[1]))];
add(ags.at(-1) ?? null, 'smallest agency');
const fscHtml = (await get('/fsc/5330/')) ?? '';
add((fscHtml.match(/href="(\/fsc\/5330\/2\/)"/) || [])[1] ?? null, 'class page 2');
const openHtml = (await get('/open/')) ?? '';
const openLinks = [...new Set([...openHtml.matchAll(/href="(\/open\/\d{4}\/)"/g)].map((m) => m[1]))];
add(openLinks.at(-1) ?? null, 'small open class');
const grp = [...new Set([...((await get('/browse/')) ?? '').matchAll(/href="(\/group\/\d+\/)"/g)].map((m) => m[1]))];
add(grp.at(-1) ?? null, 'small group');
add(await firstOk(['/watchlist/']), 'watchlist');
add(await firstOk(['/search/?q=5310-00-015-3857', '/search/?q=SPE7M1']), 'search by number');
fs.writeFileSync(outFile, out.join('\n') + '\n');
console.log(out.length, 'routes');
await pool.end();
