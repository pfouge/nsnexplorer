#!/usr/bin/env node
// ingest/sam-entities/load.mjs
// Streams a SAM.gov PUBLIC V2 monthly entity extract (the ZIP from fetch.mjs, or a bare .dat)
// line by line, keeps only entities whose CAGE is in pub.suppliers, maps them (map.mjs) and
// upserts pub.supplier_sam in batches of 500 in CAGE order (so concurrent loaders cannot
// deadlock). Also copies the UEI onto pub.suppliers where it differs.
//
// The ZIP is never held in memory: `unzip -p` (preinstalled on GitHub's ubuntu runners) writes
// the .dat entry to a pipe that readline consumes. Only matching rows are kept (a few thousand).
//
// Lines that do not fit the layout are skipped and counted, with the first few logged (line number
// and length only, never the content). If more than half of the first 500 data lines are
// malformed the layout has changed under us and the run aborts without writing anything.
//
// CLI: node load.mjs --file SAM_PUBLIC_MONTHLY_V2_YYYYMMDD.ZIP|.dat

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { getPool, closePool, tx, chunk } from '../../shared/db.mjs';
import { mapLine } from './map.mjs';

const BATCH = 500;
const DRIFT_SAMPLE = 500;

export const COLUMNS = [
  'cage', 'uei', 'legal_name', 'dba_name', 'entity_url',
  'phys_line1', 'phys_line2', 'phys_city', 'phys_state', 'phys_zip', 'phys_zip4', 'phys_country',
  'mail_line1', 'mail_line2', 'mail_city', 'mail_state', 'mail_zip', 'mail_zip4', 'mail_country',
  'registration_status', 'registration_date', 'expiration_date', 'last_update_date', 'activation_date',
  'entity_start_date', 'entity_structure', 'state_of_incorporation',
  'business_types', 'sba_certifications', 'primary_naics', 'naics', 'psc', 'pocs', 'source_file',
];
const CAST = {
  registration_date: 'date', expiration_date: 'date', last_update_date: 'date', activation_date: 'date', entity_start_date: 'date',
  business_types: 'text[]', psc: 'text[]', sba_certifications: 'jsonb', naics: 'jsonb', pocs: 'jsonb',
};
const JSONB = new Set(['sba_certifications', 'naics', 'pocs']);

/** Opens `file` as a stream of text: the first .dat entry of a ZIP, or the file itself. */
export async function openExtract(file) {
  if (!/\.zip$/i.test(file)) return { stream: createReadStream(file, 'utf8'), done: async () => {} };
  const list = spawn('unzip', ['-Z1', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let names = '';
  list.stdout.on('data', (d) => { names += d; });
  const [code] = await once(list, 'close');
  if (code !== 0) throw new Error(`unzip could not read ${path.basename(file)} (exit ${code})`);
  const entries = names.split('\n').map((s) => s.trim()).filter((n) => n && !n.endsWith('/'));
  console.log(`zip entries: ${entries.join(', ') || '(none)'}`);
  // GSA's documentation says the ZIP holds one .dat file; the first live file (2026-10-13) did not,
  // so take a .dat, else a .txt/.csv, else the only entry; a nested ZIP is unpacked to /tmp first.
  const entry = entries.find((n) => /\.dat$/i.test(n))
    ?? entries.find((n) => /\.(txt|csv)$/i.test(n))
    ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) throw new Error(`${path.basename(file)} has no data entry (entries: ${entries.join(', ')})`);
  if (/\.zip$/i.test(entry)) {
    const inner = path.join(os.tmpdir(), `sam-inner-${process.pid}-${path.basename(entry)}`);
    const x = spawn('sh', ['-c', 'unzip -p "$1" "$2" > "$3"', 'sh', file, entry, inner], { stdio: 'inherit' });
    const [xc] = await once(x, 'close');
    if (xc !== 0) throw new Error(`could not unpack nested ${entry} (exit ${xc})`);
    return openExtract(inner);
  }
  const child = spawn('unzip', ['-p', file, entry], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  const exited = once(child, 'close');
  return {
    stream: child.stdout,
    done: async () => {
      const [c] = await exited;
      if (c !== 0) throw new Error(`unzip -p exited with ${c}`);
    },
  };
}

/** Reads the extract and returns the mapped rows for CAGEs in `wanted` plus line counters. */
export async function readExtract(stream, wanted, sourceFile, { log = console.log } = {}) {
  const counts = { lines: 0, records: 0, header: 0, trailer: 0, blank: 0, malformed: 0, no_cage: 0, no_public_display: 0, not_ours: 0, matched: 0 };
  const byCage = new Map();
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let warned = 0;
  for await (const line of rl) {
    counts.lines += 1;
    const r = mapLine(line, sourceFile);
    if (r.skip) {
      counts[r.skip] += 1;
      if (r.skip === 'malformed' && warned < 5) {
        warned += 1;
        log(`warn: line ${counts.lines} does not match the V2 public layout (${line.length} chars); skipped`);
      }
      if (r.skip === 'header' || r.skip === 'trailer' || r.skip === 'blank') continue;
    } else {
      counts.records += 1;
    }
    const dataLines = counts.records + counts.malformed + counts.no_cage + counts.no_public_display;
    if (dataLines === DRIFT_SAMPLE && counts.malformed > DRIFT_SAMPLE / 2) {
      throw new Error(`layout drift: ${counts.malformed} of the first ${DRIFT_SAMPLE} data lines do not match the V2 public layout; nothing was written`);
    }
    if (!r.row) continue;
    if (!wanted.has(r.row.cage)) { counts.not_ours += 1; continue; }
    counts.matched += 1;
    const prev = byCage.get(r.row.cage);
    // A CAGE should appear once; if not, an active record beats an expired one.
    if (prev && prev.registration_status === 'Active' && r.row.registration_status !== 'Active') continue;
    byCage.set(r.row.cage, r.row);
  }
  return { rows: [...byCage.values()].sort((a, b) => (a.cage < b.cage ? -1 : a.cage > b.cage ? 1 : 0)), counts };
}

function upsertSql(rows) {
  const params = [];
  const tuples = rows.map((row, i) => {
    const ph = COLUMNS.map((c, j) => {
      const v = row[c];
      params.push(JSONB.has(c) ? JSON.stringify(v ?? []) : v ?? (CAST[c] === 'text[]' ? [] : null));
      return `$${i * COLUMNS.length + j + 1}${CAST[c] ? `::${CAST[c]}` : ''}`;
    });
    return `(${ph.join(',')}, now())`;
  });
  const set = COLUMNS.filter((c) => c !== 'cage').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return {
    text: `INSERT INTO pub.supplier_sam (${COLUMNS.join(', ')}, synced_at) VALUES ${tuples.join(',')}
           ON CONFLICT (cage) DO UPDATE SET ${set}, synced_at = now()`,
    params,
  };
}

/**
 * @param {{ file: string, pool?: import('pg').Pool, log?: (s: string) => void }} o
 * @returns {Promise<object>} counters
 */
export async function loadSamEntities({ file, pool = getPool(), log = console.log }) {
  const sourceFile = path.basename(file);
  const { rows: sup } = await pool.query('SELECT cage FROM pub.suppliers');
  const wanted = new Set(sup.map((r) => String(r.cage).trim()));
  log(`suppliers to match: ${wanted.size}`);

  const { stream, done } = await openExtract(file);
  const { rows, counts } = await readExtract(stream, wanted, sourceFile, { log });
  await done();

  let upserted = 0;
  let ueiUpdated = 0;
  for (const batch of chunk(rows, BATCH)) {
    const res = await tx(async (client) => {
      const q = upsertSql(batch);
      const up = await client.query(q.text, q.params);
      const withUei = batch.filter((r) => r.uei);
      const u = await client.query(
        `UPDATE pub.suppliers s SET uei = v.uei, updated_at = now()
         FROM (SELECT unnest($1::text[]) AS cage, unnest($2::text[]) AS uei) v
         WHERE s.cage = v.cage AND s.uei IS DISTINCT FROM v.uei`,
        [withUei.map((r) => r.cage), withUei.map((r) => r.uei)]
      );
      return { up: up.rowCount, u: u.rowCount };
    }, { pool, label: 'supplier_sam batch' });
    upserted += res.up;
    ueiUpdated += res.u;
  }

  const summary = { source_file: sourceFile, ...counts, upserted, uei_updated: ueiUpdated };
  log(`sam-entities: ${JSON.stringify(summary)}`);
  return summary;
}

function parseArgs(argv) {
  const args = { file: undefined };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--file') args.file = argv[++i];
  if (!args.file) throw new Error('load.mjs: --file is required');
  return args;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { file } = parseArgs(process.argv.slice(2));
  loadSamEntities({ file })
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err.message || err);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
