#!/usr/bin/env node
// db/refresh-supplier-stats.mjs
// Rebuilds pub.supplier_stats (totals + leaderboard ranks per CAGE) by calling
// pub.refresh_supplier_stats() (migration 0011), then prints the row count and
// the top three suppliers by 12-month award dollars. One short statement on
// one connection, so it is cheap on Supabase's capped session pooler.
//
// Runs at the end of ingest-daily.yml and in deploy.yml right after the
// migrate step, so the /supplier/ leaderboard build always sees fresh ranks.
//
// Usage: node db/refresh-supplier-stats.mjs        (DATABASE_URL, else local dev DB)

import { getPool, closePool, withRetry } from '../shared/db.mjs';

export async function refreshSupplierStats(pool) {
  const { rows } = await withRetry(() => pool.query('SELECT pub.refresh_supplier_stats() AS n'), {
    label: 'refresh_supplier_stats',
  });
  const n = Number(rows[0].n);
  const top = await pool.query(
    `SELECT st.rank_dollars_12m AS rank, st.cage, s.name, st.dollars_12m, st.awards_12m
     FROM pub.supplier_stats st JOIN pub.suppliers s USING (cage)
     WHERE st.rank_dollars_12m <= 3 ORDER BY st.rank_dollars_12m`
  );
  return { rows: n, top: top.rows };
}

async function main() {
  const { rows, top } = await refreshSupplierStats(getPool());
  console.log(`supplier_stats: ${rows} supplier(s) refreshed`);
  for (const t of top) {
    console.log(`  #${t.rank} ${t.cage} ${t.name ?? '(no name)'}  $${Number(t.dollars_12m).toLocaleString('en-US')} in ${t.awards_12m} award(s), last 12 months`);
  }
  if (top.length === 0) console.log('  (no supplier has award dollars in the last 12 months)');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
