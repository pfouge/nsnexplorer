#!/usr/bin/env node
// db/backfill-fsc-names.mjs
// One-shot (idempotent, safely re-runnable) backfill that replaces
// placeholder pub.fsc.name values ('FSC NNNN', see ingest/dibbs/load.mjs
// and ingest/sam/load.mjs) with the authoritative titles curated in
// ingest/reference/fsc-names.json, for every FSC row already sitting in the
// database (rows loaded before this file existed, or rows for FSCs this
// crawl's ingest loaders haven't touched again since).
//
// Only ever overwrites a placeholder — the WHERE guard (name LIKE 'FSC %'
// OR name IS NULL) means a curated/real name already in place, from here or
// anywhere else, is never clobbered. Re-running this script after it has
// already updated every row is a safe no-op (nothing left matching the
// WHERE clause).
//
// Usage: node db/backfill-fsc-names.mjs [--database-url=postgres://...]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../shared/db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAMES_PATH = path.join(__dirname, '../ingest/reference/fsc-names.json');

function parseArgs(argv) {
  const args = { databaseUrl: undefined };
  for (const arg of argv) {
    const m = arg.match(/^--database-url=(.*)$/);
    if (m) args.databaseUrl = m[1];
  }
  return args;
}

/**
 * Applies the fsc-names backfill against the given pool. Exported so tests
 * (or ad-hoc scripts) can call it directly against an arbitrary pool/names
 * map without going through argv/env.
 *
 * @param {{ pool: import('pg').Pool, names: Record<string,string> }} opts
 * @returns {Promise<{ total: number, updated: number, unchanged: number }>}
 */
export async function backfillFscNames({ pool, names }) {
  const entries = Object.entries(names);
  let updated = 0;

  for (const [fsc, name] of entries) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) continue; // never write an empty/invented name

    const res = await pool.query(
      `UPDATE pub.fsc
         SET name = $1, updated_at = now()
       WHERE fsc = $2
         AND (name LIKE 'FSC %' OR name IS NULL)`,
      [trimmedName, fsc]
    );
    const count = res.rowCount || 0;
    updated += count;
    console.log(`${fsc}: ${count === 1 ? 'updated' : 'no matching placeholder row'} — ${trimmedName}`);
  }

  const result = { total: entries.length, updated, unchanged: entries.length - updated };
  console.log(
    `backfill-fsc-names: ${result.updated} row(s) updated out of ${result.total} curated FSC name(s) ` +
      `(${result.unchanged} already had a real name, no matching row, or an empty title)`
  );
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.databaseUrl) {
    process.env.DATABASE_URL = args.databaseUrl;
  }

  const names = JSON.parse(readFileSync(NAMES_PATH, 'utf8'));
  const pool = getPool();

  try {
    await backfillFscNames({ pool, names });
  } finally {
    await closePool();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
