#!/usr/bin/env node
// db/copy-from-neon.mjs
// One-shot data copy for the Neon -> Supabase migration (September 2026).
//
// Copies every table in schemas `pub` and `ops` from the source database
// (NEON_DATABASE_URL) to the target (DATABASE_URL) using
// COPY ... TO STDOUT | COPY ... FROM STDIN streams, in foreign-key dependency
// order. Each table is truncated and reloaded inside its own transaction, so
// reruns are idempotent. public.schema_migrations is never copied: the target
// schema must already have been applied with db/migrate.mjs.
//
// Generated columns (pub.fsc.fsg, pub.nsns.niin) are excluded from the column
// list on both sides; Postgres recomputes them on load. Identity/serial
// sequences on the target are reset to max(id) after each table so future
// inserts do not collide with copied rows.
//
// Finishes by printing source/target row counts side by side for every table
// and exits non-zero on any mismatch.
//
// Both URLs must be direct or *Session*-pooler (port 5432) connections. The
// Transaction pooler (6543) cannot run COPY or hold a transaction across
// statements.
//
// Usage:
//   NEON_DATABASE_URL=... DATABASE_URL=... node db/copy-from-neon.mjs [--verify-only]

import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { sslFor } from '../shared/db.mjs';

const { Client } = pg;

// Dependency order (parents before children). Anything in pub/ops that is
// not listed here is appended at the end and flagged, so a new table can't
// be silently skipped.
const ORDER = [
  'pub.fsc',
  'pub.agencies',
  'pub.suppliers',
  'pub.nsns',
  'pub.part_numbers',
  'pub.amsc_observations',
  'pub.solicitations',
  'pub.price_points',
  'pub.contract_actions',
  'pub.signups',
  'ops.partner_shops',
  'ops.targets',
  'ops.quotes',
  'ops.sar_cases',
  'ops.inbound_inquiries',
  'ops.magnet_metrics',
];

const VERIFY_ONLY = process.argv.includes('--verify-only');

function connect(url, label) {
  if (!url) throw new Error(`${label} is not set`);
  const port = new URL(url).port;
  if (port === '6543') {
    throw new Error(`${label} points at the Transaction pooler (6543); use the Session pooler (5432)`);
  }
  return new Client({ connectionString: url, ssl: sslFor(url) });
}

async function listTables(client) {
  const res = await client.query(`
    SELECT table_schema || '.' || table_name AS t
    FROM information_schema.tables
    WHERE table_schema IN ('pub', 'ops') AND table_type = 'BASE TABLE'
    ORDER BY 1
  `);
  return res.rows.map((r) => r.t);
}

async function copyableColumns(client, table) {
  const [schema, name] = table.split('.');
  const res = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [schema, name]
  );
  return res.rows.map((r) => r.column_name);
}

async function identityColumns(client, table) {
  const [schema, name] = table.split('.');
  const res = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`,
    [schema, name]
  );
  return res.rows.map((r) => r.column_name);
}

async function count(client, table) {
  const res = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
  return Number(res.rows[0].n);
}

function q(ident) {
  return ident
    .split('.')
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join('.');
}

async function copyTable(src, dst, table) {
  const srcCols = await copyableColumns(src, table);
  const dstCols = await copyableColumns(dst, table);
  const missing = srcCols.filter((c) => !dstCols.includes(c));
  if (missing.length) {
    throw new Error(`${table}: target is missing columns ${missing.join(', ')}`);
  }
  const cols = srcCols.map((c) => `"${c}"`).join(', ');

  await dst.query('BEGIN');
  try {
    // CASCADE clears dependent rows in child tables; they are reloaded later
    // in ORDER, so the final state is consistent.
    await dst.query(`TRUNCATE ${q(table)} CASCADE`);
    const out = src.query(copyTo(`COPY ${q(table)} (${cols}) TO STDOUT`));
    const inp = dst.query(copyFrom(`COPY ${q(table)} (${cols}) FROM STDIN`));
    await pipeline(out, inp);

    for (const col of await identityColumns(dst, table)) {
      await dst.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${`"${col}"`}) FROM ${q(table)}), 0) + 1, false)`,
        [table, col]
      );
    }
    await dst.query('COMMIT');
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    throw new Error(`${table}: ${err.message}`, { cause: err });
  }
}

async function main() {
  const src = connect(process.env.NEON_DATABASE_URL, 'NEON_DATABASE_URL');
  const dst = connect(process.env.DATABASE_URL, 'DATABASE_URL');
  await src.connect();
  await dst.connect();

  try {
    const srcTables = await listTables(src);
    const dstTables = await listTables(dst);
    const notInTarget = srcTables.filter((t) => !dstTables.includes(t));
    if (notInTarget.length) {
      throw new Error(`target is missing tables: ${notInTarget.join(', ')} (run db/migrate.mjs first)`);
    }
    const unordered = srcTables.filter((t) => !ORDER.includes(t));
    if (unordered.length) {
      console.warn(`warning: tables not in ORDER, copied last: ${unordered.join(', ')}`);
    }
    const tables = [...ORDER.filter((t) => srcTables.includes(t)), ...unordered];

    if (!VERIFY_ONLY) {
      for (const table of tables) {
        process.stdout.write(`copy ${table} ... `);
        await copyTable(src, dst, table);
        console.log('ok');
      }
    }

    console.log('\ntable                      neon   supabase   status');
    let mismatches = 0;
    for (const table of tables) {
      const [a, b] = await Promise.all([count(src, table), count(dst, table)]);
      const ok = a === b;
      if (!ok) mismatches += 1;
      console.log(
        `${table.padEnd(24)} ${String(a).padStart(8)} ${String(b).padStart(10)}   ${ok ? 'ok' : 'MISMATCH'}`
      );
    }
    if (mismatches > 0) {
      throw new Error(`${mismatches} table(s) have mismatched row counts`);
    }
    console.log(`\n${tables.length} tables match.`);
  } finally {
    await Promise.all([src.end(), dst.end()]);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
