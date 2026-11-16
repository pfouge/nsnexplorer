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
// Round-2 diagnostics (all read-only, all optional):
//   --probe WASHER,O-RING   per root: the 25 most common requirement names (share of the root's parts with
//                           characteristics, reply shapes, 3 example replies) and N sample parts WITHOUT a drawing
//   --samples 15            samples per probed root (default 15)
//   --compare-lib <file>    a second diagram.ts (usually main's): tally which builder drew each part before and
//                           now, and print samples of parts that LOST a drawing
//   --lost-samples 6        samples per (old builder, root) that lost a drawing (default 6)
//   --class-roots 5330,5331 top roots inside these classes (all parts, drawn or not)
const PROBE = new Set((opt('--probe', '') || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
const SAMPLES = Number(opt('--samples', 15));
const cmpLibArg = opt('--compare-lib', null);
const LOST_SAMPLES = Number(opt('--lost-samples', 6));
const LOST_NAMES_FOR = new Set((opt('--lost-names-for', '') || '').split('|').filter(Boolean)); // exact item names, '|' separated
const lostNameSamples = new Map();
//   --sig-class 5306,5305   for parts WITHOUT a drawing in these classes: the top full item names, and the top
//                           "signatures" (which measurable requirements the part carries) so a builder can be fitted
const SIG_ROOT = new Set((opt('--sig-root', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
const SIG_CLASS = new Set((opt('--sig-class', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
//   --fam "PLUG=^PLUG,|^PLUG$;CAP=^CAP\\b"   round-4 family sampling: per family (regex on the full upper-case item name):
//   totals, parts without a drawing, top full item names, requirement-name frequencies and N spread samples
//   (item name + every characteristic with its raw reply) of parts WITHOUT a drawing; --fam-drawn adds drawn samples
//   --fam-samples 40  --fam-fsc 4730,5310 restricts the families to those classes
const FAMS = (opt('--fam', '') || '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf('='); const nm0 = x.slice(0, i); const at = nm0.indexOf('@'); return { name: nm0, fsc: at >= 0 ? new Set(nm0.slice(at + 1).split('/')) : null, re: new RegExp(x.slice(i + 1), 'i'), total: 0, draw: 0, chars: 0, names: new Map(), req: new Map(), samples: [], k: 0, drawnSamples: [], dk: 0, fscs: new Map() }; });
const FAM_SAMPLES = Number(opt('--fam-samples', 40));
const FAM_FSC = new Set((opt('--fam-fsc', '') || '').split(',').map((x) => x.trim()).filter(Boolean));
const FAM_DRAWN = args.includes('--fam-drawn');
const CLASS_ROOTS = new Set((opt('--class-roots', '') || '').split(',').map((x) => x.trim()).filter(Boolean));

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

let C = null; // the comparison (usually main's) drawing code
let cbuilders = [];
if (cmpLibArg) {
  const cout = path.join(tmp, 'diagram-cmp.mjs');
  await build({ entryPoints: [path.resolve(cmpLibArg)], bundle: true, format: 'esm', platform: 'node', outfile: cout, logLevel: 'error', loader: { '.ts': 'ts' } });
  C = await import(pathToFileURL(cout).href);
  cbuilders = Object.entries(C).filter(([k, v]) => /^build.*Diagram$/.test(k) && k !== 'buildDiagram' && typeof v === 'function');
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

function whoDrew(builderList, svg, entries, row, dashed) {
  for (const [bname, fn] of builderList) {
    let out = null;
    try {
      out = fn(entries, { nsnDashed: dashed, itemName: row.item_name });
    } catch {
      out = null;
    }
    if (out === svg) return bname;
  }
  return 'unknown';
}
function fmtSample(row, entries) {
  const lines = [`    ${row.nsn} ${row.fsc} ${row.item_name ?? ''}`.slice(0, 160)];
  for (const e of entries.slice(0, 16)) lines.push(`      ${e.mrc ?? '-'} | ${e.requirement ?? ''} | ${(e.reply ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
  if (entries.length > 16) lines.push(`      ... ${entries.length - 16} more`);
  return lines.join('\n');
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
const probeReq = new Map(); // root -> {n, req: Map(name -> {n, mrc, ex: Set, shapes: Map})}  (ALL parts of the root with characteristics)
const probeSamples = new Map(); // root -> [{...}]  (parts without a drawing)
const probeCount = new Map();
const transitions = new Map(); // "before -> after" -> n
const lostSamples = new Map(); // "before | root" -> [...]
const lostCount = new Map();
const lostNames = new Map(); // "before | full item name" -> n
const classRoots = new Map();
const sigNames = new Map(); // fsc -> Map(full name -> {noDraw, total})
const sigSigs = new Map(); // fsc -> Map(signature -> {n, nsn, name}) // fsc -> Map(root -> {total, draw})
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
    if (C) {
      let oldSvg = null;
      try {
        oldSvg = C.buildDiagram(entries, row.fsc, { nsnDashed: dashed, itemName: row.item_name });
      } catch {
        oldSvg = null;
      }
      const oldWho = oldSvg ? whoDrew(cbuilders, oldSvg, entries, row, dashed) : 'none';
      const newWho = svg ? whoDrew(builders, svg, entries, row, dashed) : 'none';
      inc(transitions, `${oldWho} -> ${newWho}`);
      if (oldSvg && !svg) {
        const key = `${oldWho} | ${root}`;
        inc(lostCount, key);
        inc(lostNames, `${oldWho} | ${row.item_name}`);
        if (LOST_NAMES_FOR.has(row.item_name)) {
          const a2 = lostNameSamples.get(row.item_name) ?? [];
          if (a2.length < 3) {
            a2.push(fmtSample(row, entries));
            lostNameSamples.set(row.item_name, a2);
          }
        }
        const arr = lostSamples.get(key) ?? [];
        if (arr.length < LOST_SAMPLES) {
          arr.push(fmtSample(row, entries));
          lostSamples.set(key, arr);
        }
      } else if (oldSvg && svg && oldSvg !== svg && oldWho !== newWho) {
        inc(transitions, `(changed builder) ${oldWho} -> ${newWho}`);
      }
    }
    if (FAMS.length && (FAM_FSC.size === 0 || FAM_FSC.has(row.fsc))) {
      const nmU = (row.item_name ?? '').toUpperCase();
      for (const F of FAMS) {
        if (F.fsc && !F.fsc.has(row.fsc)) continue;
        if (!F.re.test(nmU)) continue;
        F.total += 1;
        inc(F.fscs, row.fsc);
        if (hasChars) F.chars += 1;
        if (svg) {
          F.draw += 1;
          if (FAM_DRAWN) { F.dk += 1; if (F.drawnSamples.length < 8 && F.dk % 11 === 1) F.drawnSamples.push(fmtSample(row, entries)); }
          continue;
        }
        if (!hasChars) continue;
        inc(F.names, nmU);
        const seenR = new Set();
        for (const e of entries) { if (e.requirement && !seenR.has(e.requirement)) { seenR.add(e.requirement); inc(F.req, e.requirement); } }
        F.k += 1;
        if (F.samples.length < FAM_SAMPLES && F.k % 3 === 1) F.samples.push(fmtSample(row, entries));
      }
    }
    if (CLASS_ROOTS.has(row.fsc)) {
      const m = classRoots.get(row.fsc) ?? new Map();
      const c = m.get(root) ?? { total: 0, draw: 0 };
      c.total += 1;
      if (svg) c.draw += 1;
      m.set(root, c);
      classRoots.set(row.fsc, m);
    }
    for (const SK of [...(SIG_CLASS.has(row.fsc) ? [row.fsc] : []), ...(SIG_ROOT.has(root) ? [`ROOT ${root}`] : [])]) {
      const nm = (row.item_name ?? '').toUpperCase();
      const mm = sigNames.get(SK) ?? new Map();
      const c = mm.get(nm) ?? { noDraw: 0, total: 0 };
      c.total += 1;
      if (!svg) c.noDraw += 1;
      mm.set(nm, c);
      sigNames.set(SK, mm);
      if (!svg && hasChars) {
        const meas = [...new Set(entries.filter((e) => /(INCHES|MILLIMETERS|MILS|CENTIMETERS)/i.test(e.reply ?? '') && e.requirement).map((e) => e.requirement))].sort();
        const sg = sigSigs.get(SK) ?? new Map();
        const key = meas.join(' + ').slice(0, 230) || '(no measurable requirement)';
        const g = sg.get(key) ?? { n: 0, nsn: row.nsn, name: row.item_name };
        g.n += 1;
        sg.set(key, g);
        if (sg.size < 4000 || sg.has(key)) sigSigs.set(SK, sg);
      }
    }
    if (PROBE.has(root)) {
      inc(probeCount, root);
      if (hasChars) {
        const agg = probeReq.get(root) ?? { n: 0, req: new Map() };
        agg.n += 1;
        const seen = new Set();
        for (const e of entries) {
          if (!e.requirement || seen.has(e.requirement)) continue;
          seen.add(e.requirement);
          let q = agg.req.get(e.requirement);
          if (!q) {
            if (agg.req.size >= 300) continue;
            q = { n: 0, mrc: e.mrc, ex: new Set(), shapes: new Map() };
            agg.req.set(e.requirement, q);
          }
          q.n += 1;
          inc(q.shapes, replyShape(e.reply));
          if (q.ex.size < 3 && e.reply) q.ex.add(e.reply.replace(/\s+/g, ' ').slice(0, 80));
        }
        probeReq.set(root, agg);
      }
      if (!svg && hasChars) {
        const arr = probeSamples.get(root) ?? [];
        // spread the samples across the catalog: take every k-th undrawn part instead of the first N
        const k = (probeSamples.get(root + '#k') ?? 0) + 1;
        probeSamples.set(root + '#k', k);
        if (arr.length < SAMPLES && k % 7 === 1) {
          arr.push(fmtSample(row, entries));
          probeSamples.set(root, arr);
        }
      }
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

if (C) {
  P();
  P('## Old builder -> new builder (every part; "none" = no drawing)');
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) P(`${String(v).padStart(8)}  ${k}`);
  P();
  P('## Parts that HAD a drawing with the comparison library and have none now: counts by (old builder | root)');
  const lostSorted = [...lostCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of lostSorted.slice(0, 40)) P(`${String(v).padStart(8)}  ${k}`);
  P();
  P('## Lost drawings by full item name (top 60)');
  for (const [k, v] of [...lostNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) P(`${String(v).padStart(8)}  ${k}`);
  P();
  for (const [nm, arr] of lostNameSamples) {
    P(`### LOST SAMPLES for ${nm}`);
    for (const smp of arr) P(smp);
  }
  P();
  P('## Samples of those lost drawings');
  for (const [k, v] of lostSorted.slice(0, 20)) {
    P(`### ${k}  (${v})`);
    for (const smp of lostSamples.get(k) ?? []) P(smp);
  }
}
for (const [fsc, m] of classRoots) {
  P();
  P(`## Roots inside class ${fsc}: no-drawing / all parts`);
  for (const [root, c] of [...m.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 30)) P(`${String(c.total - c.draw).padStart(8)}  ${String(c.total).padStart(8)}  ${root}`);
}
for (const fsc of [...SIG_CLASS, ...[...SIG_ROOT].map((r) => `ROOT ${r}`)]) {
  P();
  P(`## Class ${fsc}: top item names without a drawing (no-drawing / all)`);
  for (const [nm, c] of [...(sigNames.get(fsc) ?? new Map()).entries()].filter(([, c]) => c.noDraw > 0).sort((a, b) => b[1].noDraw - a[1].noDraw).slice(0, 14)) P(`${String(c.noDraw).padStart(7)} ${String(c.total).padStart(7)}  ${nm}`);
  P(`## Class ${fsc}: top measurable-requirement signatures among parts without a drawing`);
  for (const [k, g] of [...(sigSigs.get(fsc) ?? new Map()).entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) P(`${String(g.n).padStart(7)}  ${k}   e.g. ${g.nsn} ${g.name ?? ''}`);
}
for (const F of FAMS) {
  P();
  P(`## FAMILY ${F.name}: ${F.total} parts, ${F.chars} with characteristics, ${F.draw} drawn today, ${F.chars - F.draw} undrawn with characteristics (classes: ${[...F.fscs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ':' + v).join(' ')})`);
  P('  top item names of undrawn parts with characteristics:');
  for (const [k, v] of [...F.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) P(`   ${String(v).padStart(6)}  ${k}`);
  P('  requirement names among undrawn parts with characteristics (parts):');
  for (const [k, v] of [...F.req.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) P(`   ${String(v).padStart(6)}  ${k}`);
  P(`  -- ${F.samples.length} samples without a drawing --`);
  for (const smp of F.samples) P(smp);
  if (F.drawnSamples.length) { P(`  -- ${F.drawnSamples.length} samples WITH a drawing --`); for (const smp of F.drawnSamples) P(smp); }
}
for (const root of PROBE) {
  const agg = probeReq.get(root);
  P();
  P(`## PROBE ${root}: ${probeCount.get(root) ?? 0} parts, ${agg?.n ?? 0} with characteristics`);
  if (agg) {
    P('requirement [MRC]  share of parts | reply shapes | examples');
    for (const [name, q] of [...agg.req.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
      const shapes = [...q.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sh, n]) => `${sh} ${Math.round((100 * n) / q.n)}%`).join(', ');
      P(`  ${name} [${q.mrc ?? '-'}]  ${Math.round((100 * q.n) / agg.n)}%  | ${shapes}  | ${[...q.ex].join('  //  ')}`);
    }
  }
  P(`  -- ${probeSamples.get(root)?.length ?? 0} sample parts without a drawing --`);
  for (const smp of probeSamples.get(root) ?? []) P(smp);
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
