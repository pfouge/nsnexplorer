#!/usr/bin/env node
// db/migrate.mjs
// Applies db/migrations/*.sql in filename order, each inside its own
// transaction, recording applied filenames in public.schema_migrations.
// Idempotent: already-applied migrations are skipped.
//
// Bootstrap special case: 0001_init.sql may already have been applied by
// hand (as it was on the `gpx` dev database) before schema_migrations
// existed. On first run, if public.schema_migrations does not exist yet but
// pub.nsns already does, we seed schema_migrations with a row for
// 0001_init.sql instead of re-running it (which would fail on
// already-existing objects).
//
// Usage: node db/migrate.mjs [--database-url=postgres://...]

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslFor } from '../shared/db.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_LOCAL_URL = 'postgresql://root@127.0.0.1:5432/gpx';

function parseArgs(argv) {
  const args = { databaseUrl: undefined };
  for (const arg of argv) {
    const m = arg.match(/^--database-url=(.*)$/);
    if (m) args.databaseUrl = m[1];
  }
  return args;
}

async function tableExists(client, schema, table) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return res.rowCount > 0;
}

async function ensureMigrationsTable(client) {
  const hasTable = await tableExists(client, 'public', 'schema_migrations');
  if (hasTable) return;

  await client.query(`
    CREATE TABLE public.schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Bootstrap: 0001 was applied by hand before this table existed.
  const pubNsnsExists = await tableExists(client, 'pub', 'nsns');
  if (pubNsnsExists) {
    await client.query(
      `INSERT INTO public.schema_migrations (filename) VALUES ('0001_init.sql')
       ON CONFLICT (filename) DO NOTHING`
    );
  }
}

async function getAppliedMigrations(client) {
  const res = await client.query(
    `SELECT filename FROM public.schema_migrations`
  );
  return new Set(res.rows.map((r) => r.filename));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString =
    args.databaseUrl || process.env.DATABASE_URL || DEFAULT_LOCAL_URL;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Session pooler (5432) or direct connection only — never the Transaction
  // pooler, which cannot run multi-statement migration files.
  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`apply ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO public.schema_migrations (filename) VALUES ($1)`,
          [file]
        );
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
      }
    }

    console.log(
      appliedCount === 0
        ? 'migrate: no-op, all migrations already applied'
        : `migrate: applied ${appliedCount} migration(s)`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
