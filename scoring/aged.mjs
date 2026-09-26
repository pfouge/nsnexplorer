#!/usr/bin/env node
// scoring/aged.mjs
// The aged-solicitation filter (Quoter fast lane) per docs/scoring-model-v1.md.
// Flags solicitations where ALL of:
//   1. status='open' and return_by is past, OR issued > 30 days ago with no award;
//   2. award history shows <=2 distinct bidders in 5yrs (or prior attempts unawarded);
//   3. our margin at (last-award-price - 10%) clears 20%;
//   4. quantity x price is inside the size-fit sweet spot ($2.5k-$25k).
//
// Prints the candidate list. Writes nothing to the database (informational
// only — this is also the calibration set for the first 50 hand quotes).
//
// DATA GAP: "our margin" needs a supplier cost basis, sourced the same way
// as scoring/score.mjs's Quoter P/M factors — from ops.quotes when present.
// Solicitations with no cost basis on file cannot have margin evaluated and
// are excluded from the aged list (not enough information to clear the
// 20% bar), not silently assumed to pass.
//
// CLI:
//   node aged.mjs

import { getPool, closePool } from '../shared/db.mjs';

const SWEET_SPOT_MIN = 2500;
const SWEET_SPOT_MAX = 25000;
const MARGIN_CLEAR_THRESHOLD = 0.2; // 20%

async function findAgedCandidates(client) {
  const res = await client.query(
    `SELECT sol_number, nsn, quantity, issued_on, return_by, status
     FROM pub.solicitations
     WHERE nsn IS NOT NULL
       AND (
         (status = 'open' AND return_by IS NOT NULL AND return_by < CURRENT_DATE)
         OR (issued_on IS NOT NULL AND issued_on < (CURRENT_DATE - INTERVAL '30 days') AND status != 'awarded')
       )`
  );

  const candidates = [];

  for (const sol of res.rows) {
    // Criterion 2: distinct winning CAGEs in 5yr, or prior unawarded attempts.
    const cageRes = await client.query(
      `SELECT COUNT(DISTINCT cage) AS n FROM pub.price_points
       WHERE nsn = $1 AND cage IS NOT NULL AND awarded_on >= (CURRENT_DATE - INTERVAL '5 years')`,
      [sol.nsn]
    );
    const distinctCages = Number(cageRes.rows[0].n);

    const unawardedRes = await client.query(
      `SELECT COUNT(*) AS n FROM pub.solicitations
       WHERE nsn = $1 AND sol_number != $2 AND status IN ('cancelled', 'expired')`,
      [sol.nsn, sol.sol_number]
    );
    const priorUnawarded = Number(unawardedRes.rows[0].n) > 0;

    if (distinctCages > 2 && !priorUnawarded) continue;

    // Criterion 3: margin at last-award-price - 10% clears 20%.
    const lastAwardRes = await client.query(
      `SELECT unit_price FROM pub.price_points WHERE nsn = $1 ORDER BY awarded_on DESC LIMIT 1`,
      [sol.nsn]
    );
    if (lastAwardRes.rowCount === 0) continue;
    const lastAwardPrice = Number(lastAwardRes.rows[0].unit_price);

    const quoteRes = await client.query(
      `SELECT supplier_cost FROM ops.quotes
       WHERE nsn = $1 AND supplier_cost IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [sol.nsn]
    );
    if (quoteRes.rowCount === 0) continue; // no cost basis on file — cannot evaluate margin
    const supplierCost = Number(quoteRes.rows[0].supplier_cost);

    const bidPrice = lastAwardPrice * 0.9;
    if (bidPrice <= 0) continue;
    const marginPct = (bidPrice - supplierCost) / bidPrice;
    if (marginPct < MARGIN_CLEAR_THRESHOLD) continue;

    // Criterion 4: quantity x price inside the size-fit sweet spot.
    if (!sol.quantity) continue;
    const totalValue = Number(sol.quantity) * lastAwardPrice;
    if (totalValue < SWEET_SPOT_MIN || totalValue > SWEET_SPOT_MAX) continue;

    candidates.push({
      solNumber: sol.sol_number,
      nsn: sol.nsn,
      status: sol.status,
      issuedOn: sol.issued_on,
      returnBy: sol.return_by,
      distinctCages,
      priorUnawarded,
      lastAwardPrice,
      supplierCost,
      marginPct,
      totalValue,
    });
  }

  return candidates;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const candidates = await findAgedCandidates(client);
    console.log(`aged.mjs: ${candidates.length} aged-solicitation candidate(s) found\n`);
    for (const c of candidates) {
      console.log(
        `${c.solNumber}  nsn=${c.nsn}  status=${c.status}  issued=${c.issuedOn ?? '?'}  ` +
          `return_by=${c.returnBy ?? '?'}  bidders_5yr=${c.distinctCages}  prior_unawarded=${c.priorUnawarded}  ` +
          `margin=${(c.marginPct * 100).toFixed(1)}%  total_value=$${c.totalValue.toFixed(2)}`
      );
    }
  } finally {
    client.release();
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
