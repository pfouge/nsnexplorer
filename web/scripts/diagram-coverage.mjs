#!/usr/bin/env node
// Drawing coverage report: how many NSNs get a dimensioned drawing / list thumbnail today, by builder, and
// what the parts WITHOUT a drawing look like (top item-name roots, top classes, and which FLIS requirements
// are present on most parts of each root, i.e. which dimensions are reliably available).
//
//   DATABASE_URL=postgresql://... node web/scripts/diagram-coverage.mjs
//   node web/scripts/diagram-coverage.mjs --db <url> [--lib web/src/lib/diagram.ts] [--json out.json]
//        [--roots 60] [--classes 30] [--share 0.6] [--page 5000] [--limit N]
//
// READ ONLY. One connection, one READ ONLY transaction, keyset pages of 5,000 rows
// (SELECT ... FROM pub.nsns LEFT JOIN pub.fsc WHERE nsn > $last ORDER BY nsn LIMIT 5000). It issues no other
// statement and writes nothing to the database. Memory use is a few counters per item-name root.
//
// The drawing code is the real web/src/lib/diagram.ts, bundled with esbuild (the same way verify-single-query.mjs
// bundles the loaders). --lib points at another copy, e.g. a "before" snapshot:
//   git show origin/main:web/src/lib/diagram.ts > /tmp/before/diagram.ts   (only diagram.ts, it has no value imports on main)
//   node web/scripts/diagram-coverage.mjs --lib /tmp/before/diagram.ts
//
// "Builder" is found by calling every exported build*Diagram function and comparing its SVG with buildDiagram's
// output, so the same script measures old and new code.

import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const dbUrl = opt('--db', process.env.DATABASE_URL);
if (!dbUrl) {
  console.error('diagram-coverage: pass --db <url> or set DATABASE_URL');
  process.exit(2);
}
const libPath = path.resolve(opt('--lib', path.join(here, '..', 'src', 'lib', 'diagram.ts')));
const TOP_ROOTS = Number(opt('--roots', 60));
const TOP_CLASSES = Number(opt('--classes', 30));
const SHARE = Number(opt('--share', 0.6));
const PAGE = Number(opt('--page', 5000));
const LIMIT = Number(opt('--limit', 0)) || Infinity;
const jsonOut = opt('--json', null);

// ---- load the drawing code ------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-coverage-'));
const outfile = path.join(tmp, 'diagram.mjs');
await build({
  entryPoints: [libPath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'error',
  loader: { '.ts': 'ts' },
});
const D = await import(pathToFileURL(outfile).href);
const builders = Object.entries(D).filter(([k, v]) => /^build.*Diagram$/.test(k) && k !== 'buildDiagram' && typeof v === 'function');
if (typeof D.buildDiagram !== 'function' || typeof D.buildThumbnail !== 'function') {
  console.error('diagram-coverage: the library must export buildDiagram and buildThumbnail');
  process.exit(2);
}

// ---- helpers ----------------------------------------------------------------------------------
function cleanEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ mrc: clean(e.mrc), requirement: clean(e.requirement), reply: clean(e.reply) }))
    .filter((e) => e.reply !== null || e.requirement !== null);
}
const rootOf = (name) => (name ?? '').split(',')[0].trim().toUpperCase() || '(NO NAME)';
const inc = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

// A coarse look at how a reply is written, so the report says which parts of a requirement are usable.
function replyShape(reply) {
  if (reply === null || reply === undefined) return 'empty';
  const r = reply.toUpperCase().replace(/\s+/g, ' ').trim();
  const m = r.match(/\b(INCHES|MILLIMETERS|CENTIMETERS|FEET|DEGREES|FAHRENHEIT|CELSIUS)\b/);
  const prefix = m ? r.slice(0, m.index).trim() : '';
  if (m && prefix) return 'qualified+' + m[1].toLowerCase();
  if (m && /\bMINIMUM\b.*\bAND\b.*\bMAXIMUM\b/.test(r)) return 'range ' + m[1].toLowerCase();
  if (m && /\bMAXIMUM\b/.test(r)) return 'max-only ' + m[1].toLowerCase();
  if (m && /\bMINIMUM\b/.test(r)) return 'min-only ' + m[1].toLowerCase();
  if (m) return 'value ' + m[1].toLowerCase();
  return 'text/code';
}

// ---- counters ---------------------------------------------------------------------------------
let parts = 0;
let withChars = 0;
let withDrawing = 0;
let withThumb = 0;
let drawingNoThumb = 0;
let thumbNoDrawing = 0;
let errors = 0;
const byBuilder = new Map(); // builder -> drawings
const byBuilderThumb = new Map(); // builder -> thumbs (thumbs counted under the builder of the diagram when it exists)
const unknownBuilder = new Map();
const rootsAll = new Map(); // root -> {parts, chars, draw}
const classesNo = new Map(); // fsc -> {name, noDraw, total, withChars}
const rootReq = new Map(); // root -> {n, req: Map(key -> {n, mrc, name, example, shapes: Map})}  (parts WITHOUT a drawing, with characteristics)
const REQ_CAP = 400; // distinct requirement keys kept per root

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: (() => {
    try {
      const u = new URL(dbUrl);
      if (u.searchParams.get('sslmode') === 'disable') return undefined;
      const h = u.hostname;
      return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' ? undefined : { rejectUnauthorized: false };
    } catch {
      return undefined;
    }
  })(),
  statement_timeout: 120000,
});
await client.connect();
await client.query('BEGIN TRANSACTION READ ONLY');

const t0 = Date.now();
let last = '';
outer: for (;;) {
  const res = await client.query(
    `SELECT n.nsn, n.fsc, n.item_name, n.characteristics, f.name AS fsc_name
       FROM pub.nsns n LEFT JOIN pub.fsc f ON f.fsc = n.fsc
      WHERE n.nsn > $1 ORDER BY n.nsn LIMIT $2`,
    [last, PAGE]
  );
  if (res.rows.length === 0) break;
  for (const row of res.rows) {
    last = row.nsn;
    if (parts >= LIMIT) break outer;
    parts += 1;
    const entries = cleanEntries(row.characteristics);
    const hasChars = entries.length > 0;
    if (hasChars) withChars += 1;
    const root = rootOf(row.item_name);
    const dashed = `${row.nsn.slice(0, 4)}-${row.nsn.slice(4, 6)}-${row.nsn.slice(6, 9)}-${row.nsn.slice(9, 13)}`;
    let svg = null;
    let thumb = null;
    try {
      svg = D.buildDiagram(entries, row.fsc, { nsnDashed: dashed, itemName: row.item_name });
      thumb = D.buildThumbnail(entries, row.fsc, row.item_name);
    } catch (err) {
      errors += 1;
      if (errors <= 5) console.error('builder threw for', row.nsn, String(err?.message ?? err));
    }
    const r = rootsAll.get(root) ?? { parts: 0, chars: 0, draw: 0 };
    r.parts += 1;
    if (hasChars) r.chars += 1;
    const cls = classesNo.get(row.fsc) ?? { name: row.fsc_name ?? '', noDraw: 0, total: 0, withChars: 0 };
    cls.total += 1;
    if (hasChars) cls.withChars += 1;
    if (svg) {
      withDrawing += 1;
      r.draw += 1;
      let who = 'unknown';
      for (const [bname, fn] of builders) {
        let out = null;
        try {
          out = fn(entries, { nsnDashed: dashed, itemName: row.item_name });
        } catch {
          out = null;
        }
        if (out === svg) {
          who = bname;
          break;
        }
      }
      if (who === 'unknown') inc(unknownBuilder, `${row.fsc} ${root}`);
      inc(byBuilder, who);
      if (thumb) inc(byBuilderThumb, who);
      else drawingNoThumb += 1;
    } else {
      cls.noDraw += 1;
      if (thumb) thumbNoDrawing += 1;
      if (hasChars) {
        const agg = rootReq.get(root) ?? { n: 0, req: new Map() };
        agg.n += 1;
        const seen = new Set();
        for (const e of entries) {
          if (!e.requirement) continue;
          const key = e.requirement;
          if (seen.has(key)) continue; // count parts, not entries
          seen.add(key);
          let q = agg.req.get(key);
          if (!q) {
            if (agg.req.size >= REQ_CAP) continue;
            q = { n: 0, mrc: e.mrc, example: e.reply, shapes: new Map() };
            agg.req.set(key, q);
          }
          q.n += 1;
          inc(q.shapes, replyShape(e.reply));
        }
        rootReq.set(root, agg);
      }
    }
    if (thumb) withThumb += 1;
    rootsAll.set(root, r);
    classesNo.set(row.fsc, cls);
  }
  if (res.rows.length < PAGE) break;
}
await client.query('ROLLBACK');
await client.end();
fs.rmSync(tmp, { recursive: true, force: true });

// ---- report ---------------------------------------------------------------------------------
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
const out = [];
const P = (s = '') => out.push(s);

P(`# Drawing coverage  (${new Date().toISOString().slice(0, 10)}, ${((Date.now() - t0) / 1000).toFixed(1)} s, library ${path.relative(process.cwd(), libPath)})`);
P();
P(`parts (pub.nsns)                 ${parts}`);
P(`parts with characteristics       ${withChars}  (${pct(withChars, parts)} of parts)`);
P(`parts with a full drawing        ${withDrawing}  (${pct(withDrawing, parts)} of parts, ${pct(withDrawing, withChars)} of parts with characteristics)`);
P(`parts with a list thumbnail      ${withThumb}  (${pct(withThumb, parts)})   [the "Has drawing" filter on class and open-demand pages uses the thumbnail]`);
P(`drawing but no thumbnail         ${drawingNoThumb}`);
P(`thumbnail but no drawing         ${thumbNoDrawing}`);
if (errors) P(`builder exceptions               ${errors}   (printed above)`);
P();
P('## Drawings by builder');
for (const [k, v] of [...byBuilder.entries()].sort((a, b) => b[1] - a[1])) {
  P(`${String(v).padStart(8)}  ${k}   (thumbnail too: ${byBuilderThumb.get(k) ?? 0})`);
}
if (byBuilder.size === 0) P('       0  (none)');
if (unknownBuilder.size) {
  P();
  P('Drawings whose builder could not be identified (FSC + root):');
  for (const [k, v] of [...unknownBuilder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) P(`${String(v).padStart(8)}  ${k}`);
}

const noDrawRoots = [...rootsAll.entries()]
  .map(([root, r]) => ({ root, parts: r.parts, chars: r.chars, noDraw: r.parts - r.draw }))
  .filter((r) => r.noDraw > 0)
  .sort((a, b) => b.noDraw - a.noDraw || a.root.localeCompare(b.root));
P();
P(`## Item-name roots with no drawing (top ${TOP_ROOTS} of ${noDrawRoots.length}; root = text before the first comma)`);
P('no-drawing parts / all parts of the root / of those, with characteristics');
for (const r of noDrawRoots.slice(0, TOP_ROOTS)) P(`${String(r.noDraw).padStart(8)}  ${String(r.parts).padStart(8)}  ${String(r.chars).padStart(8)}  ${r.root}`);

const noDrawClasses = [...classesNo.entries()]
  .map(([fsc, c]) => ({ fsc, ...c }))
  .filter((c) => c.noDraw > 0)
  .sort((a, b) => b.noDraw - a.noDraw || a.fsc.localeCompare(b.fsc));
P();
P(`## Classes with no drawing (top ${TOP_CLASSES} of ${noDrawClasses.length})`);
P('no-drawing parts / all parts in the class / of those, with characteristics');
for (const c of noDrawClasses.slice(0, TOP_CLASSES)) P(`${String(c.noDraw).padStart(8)}  ${String(c.total).padStart(8)}  ${String(c.withChars).padStart(8)}  ${c.fsc} ${c.name}`);

P();
P(`## Requirements present on >= ${Math.round(SHARE * 100)}% of the no-drawing parts that have characteristics, per root (top ${TOP_ROOTS} roots)`);
P('requirement name [MRC]  share of parts  | how the reply is written (most common first)  | example reply');
const jsonRoots = [];
for (const r of noDrawRoots.slice(0, TOP_ROOTS)) {
  const agg = rootReq.get(r.root);
  P();
  if (!agg || agg.n === 0) {
    P(`### ${r.root}  (${r.noDraw} parts, none with characteristics)`);
    jsonRoots.push({ root: r.root, noDraw: r.noDraw, partsWithChars: 0, reliable: [] });
    continue;
  }
  const rel = [...agg.req.entries()]
    .map(([name, q]) => ({ name, mrc: q.mrc, share: q.n / agg.n, shapes: [...q.shapes.entries()].sort((a, b) => b[1] - a[1]), example: q.example }))
    .filter((q) => q.share >= SHARE)
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  P(`### ${r.root}  (${r.noDraw} parts without a drawing, ${agg.n} with characteristics)`);
  if (rel.length === 0) P('  (no requirement reaches the share threshold)');
  for (const q of rel.slice(0, 40)) {
    const shapes = q.shapes.slice(0, 3).map(([s, n]) => `${s} ${Math.round((100 * n) / (q.share * agg.n))}%`).join(', ');
    P(`  ${q.name} [${q.mrc ?? '-'}]  ${Math.round(q.share * 100)}%  | ${shapes}  | ${(q.example ?? '').replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  jsonRoots.push({ root: r.root, noDraw: r.noDraw, partsWithChars: agg.n, reliable: rel.map((q) => ({ name: q.name, mrc: q.mrc, share: +q.share.toFixed(3) })) });
}

console.log(out.join('\n'));
if (jsonOut) {
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        parts, withChars, withDrawing, withThumb, drawingNoThumb, thumbNoDrawing,
        byBuilder: Object.fromEntries(byBuilder),
        roots: noDrawRoots.slice(0, TOP_ROOTS),
        classes: noDrawClasses.slice(0, TOP_CLASSES),
        reliable: jsonRoots,
      },
      null,
      2
    )
  );
}
