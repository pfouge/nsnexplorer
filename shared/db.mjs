// shared/db.mjs
// Shared Postgres access: a single pg Pool plus two small helpers used by every
// ingest/scoring package. Keep this dependency-free apart from `pg`.

import pg from 'pg';

const { Pool } = pg;

const DEFAULT_LOCAL_URL = 'postgresql://root@127.0.0.1:5432/gpx';

/**
 * TLS settings for a connection string: hosted Postgres (Supabase's Session
 * pooler, port 5432) requires TLS; the local dev database does not offer it.
 * Exported so db/migrate.mjs and db/copy-from-neon.mjs use the same rule.
 */
export function sslFor(connectionString) {
  const host = new URL(connectionString).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return local ? undefined : { rejectUnauthorized: false };
}

let _pool;

/**
 * Returns the shared pg Pool, created lazily from process.env.DATABASE_URL
 * (falling back to the local dev database). In CI, DATABASE_URL is the
 * Supabase Session pooler string (port 5432), which behaves like a direct
 * connection (COPY, prepared statements, multi-statement migrations). Reused across calls so callers
 * don't each open their own pool.
 */
export function getPool() {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL || DEFAULT_LOCAL_URL;
    _pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  }
  return _pool;
}

/**
 * Closes the shared pool. Mostly useful for tests/CLI scripts that need the
 * process to exit promptly.
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

/**
 * Runs `fn(client)` inside a BEGIN/COMMIT transaction on a dedicated client
 * checked out from the pool. Rolls back and rethrows on error. Always
 * releases the client back to the pool.
 *
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function tx(fn) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
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
}

/**
 * Builds and executes an INSERT ... ON CONFLICT (conflictCols) DO UPDATE
 * upsert for a single row. Table name must include the schema, e.g.
 * 'pub.suppliers'. `row` is a plain object of column -> value.
 *
 * Columns present in conflictCols are used as the ON CONFLICT target and are
 * never included in the DO UPDATE SET list. If every column is a conflict
 * column, falls back to DO NOTHING (nothing left to update).
 *
 * @param {string} table - schema-qualified table name, e.g. 'pub.suppliers'
 * @param {string[]} conflictCols - columns forming the unique/PK constraint
 * @param {Record<string, any>} row - column -> value
 * @param {{ client?: pg.PoolClient | pg.Pool, returning?: string }} [opts]
 */
export async function upsert(table, conflictCols, row, opts = {}) {
  const executor = opts.client || getPool();
  const columns = Object.keys(row);
  if (columns.length === 0) {
    throw new Error(`upsert(${table}): row has no columns`);
  }

  const values = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`);

  const updateCols = columns.filter((c) => !conflictCols.includes(c));
  const conflictTarget = conflictCols.join(', ');

  let onConflict;
  if (updateCols.length === 0) {
    onConflict = `ON CONFLICT (${conflictTarget}) DO NOTHING`;
  } else {
    const setClause = updateCols
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    onConflict = `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause}`;
  }

  const returning = opts.returning ? ` RETURNING ${opts.returning}` : '';

  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ${onConflict}${returning}`;

  return executor.query(sql, values);
}
