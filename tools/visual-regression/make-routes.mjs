// Builds the full route list from the data in the snapshot database, so every page type is covered
// with real records. usage: node make-routes.mjs <base_url> <routes.base.txt> <out.txt>
// env DATABASE_URL (the local snapshot). Prints the chosen routes (public paths only).
import fs from 'node:fs';
import pg from 'pg';

const [base, baseFile, outFile] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const q = async (sql) => (await pool.query(sql)).rows;
const get = async (p) => { try { const r = await fetch(base + p); return r.ok ? await r.text() : null; } catch { return null; } };
const firstOk = async (cands) => { for (const c of cands) if (await get(c)) return c; return null; };
const out = fs.readFileSync(baseFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const add = (r, why) => { if (r && !out.includes(r)) { out.push(r); console.log('route', r, why); } else if (!r) console.log('MISSING route for', why); };

// Classes: the large one is fsc 5330 (brief), the small one the deep class with the fewest NSNs.
const small = await q(`select f.fsc from pub.fsc f join pub.nsns n on n.fsc=f.fsc where f.render_depth='deep' group by f.fsc order by count(*) asc, f.fsc limit 12`);
const large = await q(`select f.fsc from pub.fsc f join pub.nsns n on n.fsc=f.fsc where f.render_depth='deep' group by f.fsc order by count(*) desc, f.fsc limit 12`);
const bigFsc = (await firstOk(['/fsc/5330/', ...large.map((r) => `/fsc/${r.fsc}/`)]));
const smallFsc = await firstOk(small.map((r) => `/fsc/${r.fsc}/`));
add(smallFsc, 'small class');
add(bigFsc, 'large class');
const fsg = bigFsc ? bigFsc.match(/\/fsc\/(\d\d)/)[1] : null;
if (fsg) add(await firstOk([`/group/${fsg}/`]), 'group page');
// Open demand: the class with the most open solicitations.
const open = await q(`select fsc from pub.solicitations where status='open' and fsc is not null group by fsc order by count(*) desc, fsc limit 8`);
add(await firstOk(open.map((r) => `/open/${r.fsc}/`)), 'open class page');
// Agency and supplier: first links on their index pages (ranked by dollars / awards).
const ag = (await get('/agencies/'))?.match(/href="(\/agency\/[^"]+\/)"/);
add(ag?.[1] ?? null, 'agency');
const sp = (await get('/supplier/'))?.match(/href="(\/supplier\/[A-Za-z0-9]{5}\/)"/);
add(sp?.[1] ?? null, 'supplier');
// A solicitation.
const sols = await q(`select sol_number from pub.solicitations where status='open' order by return_by desc nulls last, sol_number limit 10`);
add(await firstOk(sols.map((r) => `/solicitation/${encodeURIComponent(r.sol_number)}/`)), 'solicitation');
// Part pages: look through a class page for NSNs; one with a dimensioned drawing, two without.
const html = (await get(bigFsc ?? smallFsc)) ?? '';
const nsns = [...new Set([...html.matchAll(/href="\/nsn\/(\d{4}-\d{2}-\d{3}-\d{4})\/"/g)].map((m) => m[1]))].slice(0, 60);
const withD = [], without = [];
for (const n of nsns) {
  const t = await get(`/nsn/${n}/`);
  if (!t) continue;
  (t.includes('Dimensioned drawing') ? withD : without).push(n);
  if (withD.length >= 1 && without.length >= 2) break;
}
withD.slice(0, 1).forEach((n) => add(`/nsn/${n}/`, 'part with drawing'));
without.slice(0, 2).forEach((n) => add(`/nsn/${n}/`, 'part without drawing'));
if (!withD.length) console.log('NOTE no part page with a drawing found among', nsns.length, 'candidates');
// Embeds.
if (bigFsc) add(`/embed${bigFsc}demand/`, 'embed class chart');
const nsnEmbed = withD[0] ?? without[0];
if (nsnEmbed) add(`/embed/nsn/${nsnEmbed}/price/`, 'embed part chart');
fs.writeFileSync(outFile, out.join('\n') + '\n');
console.log(out.length, 'routes written');
await pool.end();
