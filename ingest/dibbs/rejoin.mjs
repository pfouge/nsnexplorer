#!/usr/bin/env node
// ingest/dibbs/rejoin.mjs
// Re-runs the award -> solicitation unit-price join (pub.price_points) from award rows already in
// pub.contract_actions, without fetching anything from DIBBS.
//
// Every DIBBS award row keeps its full award-grid record in contract_actions.raw (solicitation,
// purchase request, total, award date, CAGE ...), which is all mapAwardToPricePoint needs. So when
// older solicitations arrive (the dibbs_rfq back-fill), the awards that point at them can be priced
// straight from the database. This replaced the weekly 30-day award re-crawl (~3 h on DIBBS) in
// rfq-award-join (2026-10-13).
//
// CLI:
//   node ingest/dibbs/rejoin.mjs --days 120     (awards with an award date in the last 120 days)
//   node ingest/dibbs/rejoin.mjs --all          (every DIBBS award row)

import { loadPricePointsFromAwards } from './load.mjs';
import { norm } from './join-validate.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

const DIBBS_ROWS = `SELECT raw FROM pub.contract_actions WHERE award_uid LIKE 'DIBBS-%' AND raw ? 'solicitation'`;

/**
 * Prices the stored awards whose solicitation number is one of `solNumbers` (any spelling; matched
 * on uppercase alphanumerics, the same key the join uses).
 */
export async function rejoinForSolicitations(pool, solNumbers, { loadPrices = loadPricePointsFromAwards } = {}) {
  const keys = [...new Set(solNumbers.filter(Boolean).map(norm))];
  if (keys.length === 0) return { awards: 0, matched: 0, loaded: 0, skipped: 0, skipReasons: {} };
  const { rows } = await pool.query(
    `${DIBBS_ROWS} AND regexp_replace(upper(raw->>'solicitation'), '[^A-Z0-9]', '', 'g') = ANY($1::text[])`,
    [keys]
  );
  const r = await loadPrices(rows.map((x) => x.raw), { pool });
  return { awards: rows.length, ...r };
}

/** Prices every stored award with an award date in the last `days` days (or all of them). */
export async function rejoinRecent(pool, { days = null, loadPrices = loadPricePointsFromAwards } = {}) {
  const { rows } = days
    ? await pool.query(`${DIBBS_ROWS} AND action_date >= CURRENT_DATE - $1::int`, [days])
    : await pool.query(DIBBS_ROWS);
  const r = await loadPrices(rows.map((x) => x.raw), { pool });
  return { awards: rows.length, ...r };
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const i = argv.indexOf('--days');
  const days = i >= 0 ? Number(argv[i + 1]) : null;
  if (!all && !(Number.isInteger(days) && days > 0)) throw new Error('rejoin.mjs: pass --days N or --all');
  const pool = getPool();
  try {
    const r = await rejoinRecent(pool, { days: all ? null : days });
    console.log(`rejoin.mjs: ${r.awards} stored awards -> matched=${r.matched} loaded=${r.loaded} skipped=${r.skipped} ${JSON.stringify(r.skipReasons)}`);
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
