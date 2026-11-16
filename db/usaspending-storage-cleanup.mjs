#!/usr/bin/env node
// db/usaspending-storage-cleanup.mjs
// Applies the 2026-11-15 USAspending storage decisions to rows already stored (migration 0021's functions):
//   * deletes USAspending rows of floored classes dated before the history floor
//     (ingest/usaspending/history-floor.mjs: every class except 5330 and 5331, before 2021-10-01),
//   * slims pub.contract_actions.raw of every USAspending row to its minimal form (nsn, cage),
//   * removes the history-ledger rows (ops.source_dates, lanes usaspending_<psc>) older than the floor, so a
//     later change of the floor cannot mistake a deleted month for a loaded one,
//   * runs a plain VACUUM (ANALYZE) so the freed space can be reused.
// DIBBS rows are never selected (the SQL functions exclude award_uid LIKE 'DIBBS%').
//
// One short transaction per id range (default 5,000 ids, well under a second to a few seconds), so no long lock
// and no giant WAL burst; the site keeps reading the table throughout. Safe to stop and to start again at any
// point and safe next to the nightly ingest and the backfill (idempotent; the loaders upsert on
// (award_uid, action_date)). A re-run only touches rows that still need it. Run it again after a backfill that
// started before the new loader was deployed, because that backfill's later rows are written with the old raw.
//
//   node db/usaspending-storage-cleanup.mjs --dry-run          counts only, writes nothing
//   node db/usaspending-storage-cleanup.mjs                    the whole cleanup, then VACUUM (ANALYZE)
//   options: --batch-ids 5000  --sleep-ms 250  --max-minutes 0 (0 = no limit; stops cleanly, prints --from-id to resume)
//            --vacuum-every 150000 (plain VACUUM after this many changed rows, 0 = never: it lets later batches reuse the
//            pages earlier ones freed, so the file does not grow by a third while the cleanup runs)
//            --from-id N  --no-vacuum (no VACUUM at all)  --no-delete  --no-slim
// DATABASE_URL: the Session pooler or a direct connection (not the Transaction pooler).

import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslFor } from '../shared/db.mjs';
import { HISTORY_FLOOR, NO_FLOOR_CLASSES } from '../ingest/usaspending/history-floor.mjs';

const DEFAULT_LOCAL_URL = 'postgresql://root@127.0.0.1:5432/gpx';
const USA = `ca.award_uid NOT LIKE 'DIBBS%' AND ca.source_url LIKE 'https://www.usaspending.gov/award/%'`;
const SLIM_TEST = `ca.raw <> pub.usaspending_slim_raw(ca.raw)`;
const DELETE_TEST = `${USA} AND ca.action_date < $1::date AND ca.raw ->> 'nsn' IS NULL AND ca.psc IS NOT NULL AND ca.psc::text <> ALL ($2::text[])`;

export function parseArgs(argv) {
  const a = { dryRun: false, batchIds: 5000, sleepMs: 250, maxMinutes: 0, fromId: 0, vacuum: true, vacuumEvery: 150000, del: true, slim: true };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--batch-ids') a.batchIds = Number(argv[++i]);
    else if (k === '--sleep-ms') a.sleepMs = Number(argv[++i]);
    else if (k === '--max-minutes') a.maxMinutes = Number(argv[++i]);
    else if (k === '--from-id') a.fromId = Number(argv[++i]);
    else if (k === '--vacuum-every') a.vacuumEvery = Number(argv[++i]);
    else if (k === '--no-vacuum') a.vacuum = false;
    else if (k === '--no-delete') a.del = false;
    else if (k === '--no-slim') a.slim = false;
    else if (k === '--database-url') a.databaseUrl = argv[++i];
    else throw new Error(`usaspending-storage-cleanup: unknown option ${k}`);
  }
  if (!Number.isInteger(a.batchIds) || a.batchIds < 100 || a.batchIds > 200000) throw new Error('--batch-ids takes a whole number from 100 to 200000');
  if (!Number.isFinite(a.sleepMs) || a.sleepMs < 0) throw new Error('--sleep-ms takes a number of milliseconds');
  if (!Number.isFinite(a.maxMinutes) || a.maxMinutes < 0) throw new Error('--max-minutes takes a number');
  if (!Number.isInteger(a.fromId) || a.fromId < 0) throw new Error('--from-id takes a whole number');
  if (!Number.isInteger(a.vacuumEvery) || a.vacuumEvery < 0) throw new Error('--vacuum-every takes a whole number of rows (0 = never)');
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString('en-US');
const mb = (bytes) => (Number(bytes) < 10485760 ? `${(Number(bytes) / 1024).toFixed(0)} kB` : `${(Number(bytes) / 1048576).toFixed(0)} MB`);

async function sizes(client) {
  const { rows } = await client.query(`
    SELECT pg_total_relation_size('pub.contract_actions') AS total, pg_relation_size('pub.contract_actions') AS heap,
           pg_indexes_size('pub.contract_actions') AS indexes, pg_database_size(current_database()) AS db,
           (SELECT n_live_tup FROM pg_stat_user_tables WHERE relid = 'pub.contract_actions'::regclass) AS live,
           (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relid = 'pub.contract_actions'::regclass) AS dead`);
  return rows[0];
}

export async function runCleanup({ client, args, log = console.log, now = () => Date.now() }) {
  const floor = HISTORY_FLOOR;
  const unfloored = [...NO_FLOOR_CLASSES];
  const started = now();
  const out = { deleted: 0, slimmed: 0, batches: 0, stoppedAt: null, ledgerRowsRemoved: 0 };

  const fn = await client.query(`SELECT to_regprocedure('pub.usaspending_storage_cleanup_batch(bigint,bigint,date,text[],boolean,boolean)') AS f`);
  if (!fn.rows[0].f) throw new Error('migration 0021 is not applied (pub.usaspending_storage_cleanup_batch is missing): run node db/migrate.mjs first');

  // The pre-flight counts scan the whole table: on 2026-11-16 they passed 120 s on a disk-bound database.
  await client.query(`SET statement_timeout = '900s'`);
  await client.query(`SET lock_timeout = '10s'`);

  // Pre-flight numbers (read only).
  const before = await sizes(client);
  const rowsDelete = await client.query(`SELECT count(*)::bigint AS n, 0::bigint AS attached FROM pub.contract_actions ca WHERE ${DELETE_TEST}`, [floor, unfloored]);
  const rowsSlim = await client.query(`SELECT count(*)::bigint AS n FROM pub.contract_actions ca WHERE ${USA} AND ${SLIM_TEST}`);
  const range = await client.query(`SELECT coalesce(min(id), 0)::bigint AS lo, coalesce(max(id), 0)::bigint AS hi FROM pub.contract_actions`);
  log(`cleanup: floor ${floor}, classes without a floor ${unfloored.join(', ')}`);
  log(`cleanup: contract_actions ${mb(before.total)} total (heap ${mb(before.heap)}, indexes ${mb(before.indexes)}), database ${mb(before.db)}, ~${fmt(before.live)} live / ${fmt(before.dead)} dead rows`);
  log(`cleanup: ${fmt(rowsDelete.rows[0].n)} rows to delete (older than the floor and not attached to a part)`);
  log(`cleanup: ${fmt(rowsSlim.rows[0].n)} rows to slim (raw still holds more than nsn/cage)`);
  if (args.dryRun) {
    log('cleanup: dry run, nothing written');
    return { ...out, dryRun: true, toDelete: Number(rowsDelete.rows[0].n), toSlim: Number(rowsSlim.rows[0].n) };
  }

  await client.query(`SET statement_timeout = '120s'`);
  const lo = Math.max(Number(range.rows[0].lo), args.fromId);
  const hi = Number(range.rows[0].hi);
  let lastLog = now();
  let changedSinceVacuum = 0;
  for (let from = lo; from <= hi; from += args.batchIds) {
    if (args.maxMinutes > 0 && now() - started > args.maxMinutes * 60000) {
      out.stoppedAt = from;
      log(`cleanup: time limit reached; resume with --from-id ${from}`);
      break;
    }
    const to = from + args.batchIds - 1;
    let attempt = 0;
    for (;;) {
      try {
        const { rows } = await client.query(
          `SELECT deleted, slimmed FROM pub.usaspending_storage_cleanup_batch($1, $2, $3::date, $4::text[], $5, $6)`,
          [from, to, floor, unfloored, args.del, args.slim]
        );
        out.deleted += Number(rows[0].deleted);
        out.slimmed += Number(rows[0].slimmed);
        changedSinceVacuum += Number(rows[0].deleted) + Number(rows[0].slimmed);
        break;
      } catch (err) {
        // Deadlock with a loader, lock wait, timeout: this range rolled back whole; try it again a few times.
        attempt += 1;
        if (attempt >= 5 || !['40P01', '55P03', '57014', '40001'].includes(err.code)) throw err;
        log(`cleanup: ids ${from}..${to} ${err.code} (${err.message}); retry ${attempt}`);
        await sleep(2000 * attempt);
      }
    }
    out.batches += 1;
    if (now() - lastLog >= 30000) {
      lastLog = now();
      log(`cleanup: through id ${to} of ${hi}: ${fmt(out.deleted)} deleted, ${fmt(out.slimmed)} slimmed`);
    }
    if (args.vacuum && args.vacuumEvery > 0 && changedSinceVacuum >= args.vacuumEvery) {
      // Plain VACUUM never blocks readers or writers. It frees the dead row versions of the batches so far, so the
      // next batches write their new versions into those pages instead of extending the file.
      await client.query('SET statement_timeout = 0');
      await client.query('VACUUM pub.contract_actions');
      await client.query(`SET statement_timeout = '120s'`);
      out.vacuums = (out.vacuums || 0) + 1;
      changedSinceVacuum = 0;
    }
    if (args.sleepMs) await sleep(args.sleepMs);
  }
  log(`cleanup: ${fmt(out.batches)} batches, ${fmt(out.deleted)} rows deleted, ${fmt(out.slimmed)} rows slimmed, ${out.vacuums || 0} interim VACUUMs`);

  if (args.del && !out.stoppedAt) {
    const led = await client.query(
      `DELETE FROM ops.source_dates WHERE lane LIKE 'usaspending\\_%' AND lane <> ALL ($1::text[]) AND day < $2::date`,
      [unfloored.map((c) => `usaspending_${c}`), floor]
    );
    out.ledgerRowsRemoved = led.rowCount;
    log(`cleanup: ${fmt(led.rowCount)} history-ledger months older than the floor removed (ops.source_dates)`);
  }

  if (args.vacuum && !out.stoppedAt) {
    await client.query(`SET statement_timeout = 0`);
    log('cleanup: VACUUM (ANALYZE) pub.contract_actions ...');
    await client.query('VACUUM (ANALYZE) pub.contract_actions');
    const after = await sizes(client);
    log(`cleanup: contract_actions ${mb(after.total)} total (heap ${mb(after.heap)}), database ${mb(after.db)}, ~${fmt(after.live)} live / ${fmt(after.dead)} dead rows`);
    log('cleanup: the file does not shrink after a plain VACUUM; the freed pages are reused by new rows. VACUUM FULL or pg_repack would return it to the disk (they lock the table).');
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = args.databaseUrl || process.env.DATABASE_URL || DEFAULT_LOCAL_URL;
  const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  try {
    await runCleanup({ client, args });
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
