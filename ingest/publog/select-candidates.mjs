#!/usr/bin/env node
// ingest/publog/select-candidates.mjs
// One-shot: from the PUB LOG FLIS export (already downloaded by
// fetch.mjs), find the richest-characteristic NIINs in a few mechanical
// FSCs OTHER than o-rings, and dump their full real characteristics so a
// tailored dimensioned-drawing archetype can be built from real data.
// Streams the big CSVs — never readFile. Writes ingest/publog/candidates.json.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = process.argv[process.argv.indexOf('--dir') + 1] || '/tmp/publog';
// Target categories with recognizable, drawable geometry:
//   5330 gaskets (OD/ID/thickness + bolt holes), 3120 plain bearings
//   (bore/OD/width), 4730 fittings, 5365 rings/spacers, 5310 washers.
const TARGET_FSCS = new Set(['5330', '3120', '4730', '5365', '5310']);
const PER_FSC = 3;

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function* rows(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (!header) { header = cols; continue; }
    const rec = {};
    for (let i = 0; i < header.length; i += 1) rec[header[i]] = cols[i];
    yield rec;
  }
}

async function main() {
  // 1. Names + FSC for target-FSC NIINs.
  const meta = new Map(); // niin -> { fsc, itemName }
  for await (const r of rows(path.join(DIR, 'P_FLIS_NSN.CSV'))) {
    const fsc = r.FSC, niin = r.NIIN;
    if (!TARGET_FSCS.has(fsc)) continue;
    const nm = (r.ITEM_NAME || '').trim();
    meta.set(niin, { fsc, itemName: nm === 'NO ITEM NAME AVAILABLE' ? null : nm });
  }
  console.log('target-FSC NIINs:', meta.size);

  // 2. Characteristics for those NIINs (aggregate).
  const chars = new Map(); // niin -> [{mrc, requirement, reply}]
  let scanned = 0;
  for await (const r of rows(path.join(DIR, 'V_CHARACTERISTICS.CSV'))) {
    scanned += 1;
    const niin = r.NIIN;
    if (!meta.has(niin)) continue;
    const reply = (r.CLEAR_TEXT_REPLY || r.REPLY || r.CHARACTERISTIC_VALUE || '').trim();
    const requirement = (r.REQUIREMENTS_STATEMENT || r.REQUIREMENT_STATEMENT || r.MRC_NAME || '').trim();
    const mrc = (r.MRC || '').trim();
    if (!reply && !requirement) continue;
    if (!chars.has(niin)) chars.set(niin, []);
    chars.get(niin).push({ mrc: mrc || null, requirement: requirement || null, reply: reply || null });
  }
  console.log('characteristics scanned:', scanned, 'NIINs with chars:', chars.size);

  // 3. Rank by dimension richness within each FSC; keep those that carry
  //    an OD or a diameter + a thickness/width (drawable geometry).
  const hasGeom = (arr) => {
    const txt = arr.map((e) => `${e.requirement || ''} ${e.reply || ''}`.toUpperCase()).join(' | ');
    const dims = (txt.match(/INCHES/g) || []).length;
    return dims >= 2 && /DIAMETER|WIDTH|THICKNESS|BORE/.test(txt);
  };
  const byFsc = new Map();
  for (const [niin, arr] of chars) {
    if (!hasGeom(arr)) continue;
    const { fsc, itemName } = meta.get(niin);
    if (!byFsc.has(fsc)) byFsc.set(fsc, []);
    byFsc.get(fsc).push({ nsn: fsc + niin, fsc, itemName, n: arr.length, characteristics: arr });
  }

  const out = [];
  for (const [fsc, list] of byFsc) {
    list.sort((a, b) => b.n - a.n);
    out.push(...list.slice(0, PER_FSC));
  }
  out.sort((a, b) => b.n - a.n);

  await writeFile('ingest/publog/candidates.json', JSON.stringify({ at: new Date().toISOString(), count: out.length, rows: out }, null, 2) + '\n');
  console.log('candidates written:', out.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
