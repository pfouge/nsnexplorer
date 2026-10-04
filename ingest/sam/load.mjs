#!/usr/bin/env node
// ingest/sam/load.mjs
// Loads mapped SAM.gov opportunities (see map-sam.mjs) into
// pub.solicitations (source='sam_gov') — the all-agency open-solicitation
// lane alongside the DIBBS RFQ lane (ingest/dibbs/load.mjs's
// loadRfqSolicitations). See db/migrations/0003_open_solicitations.sql for
// the shared table shape.
//
// Unlike the DIBBS RFQ lane, SAM opportunities carry no structured NSN
// (mapSamRecord always sets nsn = null), so this loader does NOT touch
// pub.nsns — a SAM row never grows the NSN catalog and will not appear on
// the NSN-keyed browse pages. Storing it here is still valuable (nothing is
// lost, the accumulating history holds it, and status/expiry tracking
// works), but surfacing null-nsn rows needs a follow-up view (e.g. an
// /open/sam/ or all-agency board page) that queries pub.solicitations
// directly instead of joining through pub.nsns. When a row does carry a
// PSC-like classificationCode, we still grow pub.fsc (harmless even with no
// NSN referencing it — pub.solicitations.fsc carries no FK) so that future
// view has category names ready.
//
// sol_number is the PRIMARY KEY across every source (DIBBS RFQ and SAM
// share the same federal solicitation-number format, so the same
// solicitation CAN legitimately show up in both feeds under the same
// sol_number). To avoid a SAM sync ever clobbering a DIBBS-loaded row's
// NSN-relevant fields (fsc derived from the NSN, DIBBS's own source_url,
// etc.), the upsert below only updates a conflicting row when it is
// already source='sam_gov' — a row owned by another source is left alone.
//
// CLI: node load.mjs --dir dir/   (reads every *.json page fetch.mjs wrote)

import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool } from '../../shared/db.mjs';
import { mapSamRecord } from './map-sam.mjs';

// Authoritative FSC (4-digit Federal Supply Class) titles — see
// ingest/dibbs/load.mjs's FSC_NAMES for sourcing notes. Loaded once at
// module load; a missing/unparsable file must never crash ingestion —
// pub.fsc rows just keep the placeholder name ('FSC ' || fsc).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let FSC_NAMES = {};
try {
  FSC_NAMES = JSON.parse(
    readFileSync(path.join(__dirname, '../reference/fsc-names.json'), 'utf8')
  );
} catch {
  FSC_NAMES = {};
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Loads SAM opportunity records (raw opportunitiesData[] entries) into
 * pub.solicitations. Maps each with mapSamRecord, skips + tallies rejects,
 * dedups by sol_number (last occurrence in `records` wins), then does a
 * batched multi-row upsert in chunks of 500. Finishes with an expire-stale
 * sweep for source='sam_gov' open rows whose return_by has passed.
 *
 * @param {object[]} records - raw SAM opportunitiesData entries
 * @param {{ pool?: import('pg').Pool }} [opts]
 * @returns {Promise<{ loaded: number, skipped: number, skipReasons: Record<string, number>, expired: number }>}
 */
export async function loadSamSolicitations(records, { pool } = {}) {
  const db = pool || getPool();

  const skipReasons = {};
  let skipped = 0;
  const solMap = new Map(); // sol_number -> row
  const fscSet = new Set();

  for (const rec of records) {
    const result = mapSamRecord(rec);
    if (result.skip) {
      skipped += 1;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }
    solMap.set(result.row.sol_number, result.row);
    if (result.row.fsc) fscSet.add(result.row.fsc);
  }

  const rows = [...solMap.values()];

  let loaded = 0;
  let expired = 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FSC catalog growth (optional — pub.solicitations.fsc carries no FK;
    // this just pre-populates a category name for a future by-category
    // all-agency view). Real title when authoritatively sourced (FSC_NAMES),
    // placeholder otherwise; DO UPDATE only overwrites an existing
    // placeholder row, never a curated/real name (name LIKE 'FSC %' guard).
    for (const c of chunk([...fscSet], 1000)) {
      if (c.length === 0) continue;
      const params = [];
      const tuples = c.map((fsc, i) => {
        params.push(fsc, FSC_NAMES[fsc] || null);
        return `($${i * 2 + 1}::text, COALESCE($${i * 2 + 2}, 'FSC ' || $${i * 2 + 1}::text))`;
      });
      await client.query(
        `INSERT INTO pub.fsc (fsc, name)
         VALUES ${tuples.join(',')}
         ON CONFLICT (fsc) DO UPDATE SET name = EXCLUDED.name
           WHERE pub.fsc.name LIKE 'FSC %'`,
        params
      );
    }

    for (const c of chunk(rows, 500)) {
      const params = [];
      const tuples = c.map((row, i) => {
        const b = i * 11;
        params.push(
          row.sol_number,
          row.quantity,
          row.issued_on,
          row.return_by,
          row.status,
          row.nomenclature,
          row.fsc,
          row.setaside,
          row.buyer_office,
          row.source_url,
          JSON.stringify(row.raw)
        );
        return `($${b + 1},NULL,$${b + 2},$${b + 3},$${b + 4},$${b + 5},'sam_gov',$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},now())`;
      });
      await client.query(
        `INSERT INTO pub.solicitations
           (sol_number, nsn, quantity, issued_on, return_by, status, source,
            nomenclature, fsc, setaside, buyer_office, source_url, raw, last_seen_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (sol_number) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           issued_on = EXCLUDED.issued_on,
           return_by = EXCLUDED.return_by,
           status = EXCLUDED.status,
           nomenclature = EXCLUDED.nomenclature,
           fsc = EXCLUDED.fsc,
           setaside = EXCLUDED.setaside,
           buyer_office = EXCLUDED.buyer_office,
           source_url = EXCLUDED.source_url,
           raw = EXCLUDED.raw,
           last_seen_at = now(),
           updated_at = now()
         WHERE pub.solicitations.source = 'sam_gov'`,
        params
      );
      loaded += c.length;
    }

    // Definitive close for the sam_gov lane only — same rationale as
    // reconcileOpenSolicitations's expiry step in ingest/dibbs/load.mjs.
    // Rows are never deleted; they become part of the accumulating history.
    const expiredResult = await client.query(
      `UPDATE pub.solicitations
         SET status = 'expired', updated_at = now()
       WHERE source = 'sam_gov'
         AND status = 'open'
         AND return_by IS NOT NULL
         AND return_by < CURRENT_DATE`
    );
    expired = expiredResult.rowCount || 0;

    // Notices without a response deadline never trip the sweep above, and a
    // notice SAM stops returning (withdrawn, archived, or aged out of the
    // posted-date window) is simply no longer seen. Close any open sam_gov
    // row this lane has not re-observed in 45 days, so "open" keeps meaning
    // "still listed".
    const staleResult = await client.query(
      `UPDATE pub.solicitations
         SET status = 'expired', updated_at = now()
       WHERE source = 'sam_gov'
         AND status = 'open'
         AND (return_by IS NULL OR return_by < CURRENT_DATE)
         AND last_seen_at < now() - interval '45 days'`
    );
    expired += staleResult.rowCount || 0;

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors; original error is what matters
    }
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `loadSamSolicitations: ${loaded} loaded, ${skipped} skipped ${JSON.stringify(skipReasons)}, ${expired} expired`
  );
  return { loaded, skipped, skipReasons, expired };
}

function parseArgs(argv) {
  const args = { dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
  }
  if (!args.dir) throw new Error('load.mjs: --dir is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = (await readdir(args.dir)).filter((f) => f.endsWith('.json')).sort();

  const records = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(path.join(args.dir, f), 'utf8'));
    records.push(...(data.opportunitiesData || []));
  }

  console.log(`load.mjs: read ${records.length} raw opportunity record(s) from ${files.length} file(s) in ${args.dir}`);

  const result = await loadSamSolicitations(records);
  console.log(
    `load.mjs: ${result.loaded} loaded, ${result.skipped} skipped ${JSON.stringify(result.skipReasons)}, ${result.expired} expired`
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
