#!/usr/bin/env node
// db/verify-supplier-stats.mjs
// Checks pub.refresh_supplier_stats() against an independent, deliberately naive
// computation: per-CAGE correlated sub-selects over pub.price_points (day-count
// arithmetic instead of date comparisons, no window functions) for every metric,
// and ranks recomputed in JavaScript by sorting. Prints one line per mismatch and
// ends with "N mismatches" (exit 1 when N > 0).
//
// Everything runs inside ONE transaction that is always rolled back, so the real
// pub.supplier_stats is left as it was. --seed first inserts synthetic suppliers
// (CAGEs T0001..) into that same transaction: ties, boundary dates (365/366/730/731
// days ago), the rising threshold ($10,000 and 3 awards exactly), awards with no
// dollar value, a supplier whose awards are all older than 24 months.
//
// Usage: node db/verify-supplier-stats.mjs [--seed]      (DATABASE_URL, else local dev DB)

import { getPool, closePool } from '../shared/db.mjs';

const NAIVE_SQL = `
SELECT s.cage,
  (SELECT count(*)::int FROM pub.price_points p WHERE p.cage = s.cage) AS awards_all,
  (SELECT trim_scale(COALESCE(sum(CASE WHEN p.total_value IS NOT NULL THEN p.total_value
                                       WHEN p.quantity IS NOT NULL THEN p.unit_price * p.quantity END), 0))
     FROM pub.price_points p WHERE p.cage = s.cage)::text AS dollars_all,
  (SELECT count(*)::int FROM pub.price_points p WHERE p.cage = s.cage AND CURRENT_DATE - p.awarded_on < 365) AS awards_12m,
  (SELECT trim_scale(COALESCE(sum(CASE WHEN p.total_value IS NOT NULL THEN p.total_value
                                       WHEN p.quantity IS NOT NULL THEN p.unit_price * p.quantity END), 0))
     FROM pub.price_points p WHERE p.cage = s.cage AND CURRENT_DATE - p.awarded_on < 365)::text AS dollars_12m,
  (SELECT count(*)::int FROM pub.price_points p WHERE p.cage = s.cage
      AND CURRENT_DATE - p.awarded_on >= 365 AND CURRENT_DATE - p.awarded_on < 730) AS awards_prior_12m,
  (SELECT trim_scale(COALESCE(sum(CASE WHEN p.total_value IS NOT NULL THEN p.total_value
                                       WHEN p.quantity IS NOT NULL THEN p.unit_price * p.quantity END), 0))
     FROM pub.price_points p WHERE p.cage = s.cage
      AND CURRENT_DATE - p.awarded_on >= 365 AND CURRENT_DATE - p.awarded_on < 730)::text AS dollars_prior_12m,
  (SELECT count(*)::int FROM (SELECT DISTINCT p.nsn FROM pub.price_points p WHERE p.cage = s.cage) x) AS nsns,
  (SELECT count(*)::int FROM (SELECT DISTINCT n.fsc FROM pub.price_points p JOIN pub.nsns n ON n.nsn = p.nsn WHERE p.cage = s.cage) x) AS fscs,
  (SELECT count(*)::int FROM (SELECT DISTINCT p.agency_id FROM pub.price_points p WHERE p.cage = s.cage AND p.agency_id IS NOT NULL) x) AS agencies,
  (SELECT min(p.awarded_on)::text FROM pub.price_points p WHERE p.cage = s.cage) AS first_award,
  (SELECT max(p.awarded_on)::text FROM pub.price_points p WHERE p.cage = s.cage) AS last_award
FROM pub.suppliers s
WHERE EXISTS (SELECT 1 FROM pub.price_points p WHERE p.cage = s.cage)
ORDER BY s.cage COLLATE "C"`;

const ACTUAL_SQL = `
SELECT cage, awards_all, trim_scale(dollars_all)::text AS dollars_all, awards_12m, trim_scale(dollars_12m)::text AS dollars_12m,
       awards_prior_12m, trim_scale(dollars_prior_12m)::text AS dollars_prior_12m, nsns, fscs, agencies,
       first_award::text AS first_award, last_award::text AS last_award,
       rank_dollars_12m, rank_dollars_all, rank_wins_12m, rank_wins_all, rank_nsns, rank_fscs, rank_rising,
       trim_scale(rising_delta)::text AS rising_delta
FROM pub.supplier_stats ORDER BY cage COLLATE "C"`;

/** 1..k by metric desc, ties by cage asc (code-point order); null where `eligible` is false. */
function rankBy(rows, metric, eligible = () => true) {
  const ranks = new Map();
  rows
    .filter((r) => eligible(r))
    .sort((a, b) => (b[metric] - a[metric]) || (a.cage < b.cage ? -1 : a.cage > b.cage ? 1 : 0))
    .forEach((r, i) => ranks.set(r.cage, i + 1));
  return ranks;
}

export function expectedRanks(naive) {
  const rows = naive.map((r) => ({
    cage: r.cage,
    dollars_12m: Number(r.dollars_12m),
    dollars_all: Number(r.dollars_all),
    awards_12m: r.awards_12m,
    awards_all: r.awards_all,
    nsns: r.nsns,
    fscs: r.fscs,
    delta: Number(r.dollars_12m) - Number(r.dollars_prior_12m),
  }));
  const pos = (m) => (r) => r[m] > 0;
  return {
    rank_dollars_12m: rankBy(rows, 'dollars_12m', pos('dollars_12m')),
    rank_dollars_all: rankBy(rows, 'dollars_all', pos('dollars_all')),
    rank_wins_12m: rankBy(rows, 'awards_12m', pos('awards_12m')),
    rank_wins_all: rankBy(rows, 'awards_all', pos('awards_all')),
    rank_nsns: rankBy(rows, 'nsns', pos('nsns')),
    rank_fscs: rankBy(rows, 'fscs', pos('fscs')),
    rank_rising: rankBy(rows, 'delta', (r) => r.dollars_12m >= 10000 && r.awards_12m >= 3),
    delta: new Map(rows.map((r) => [r.cage, r.delta])),
  };
}

async function seed(client) {
  const fscs = (await client.query(`SELECT fsc FROM pub.fsc WHERE fsc ~ '^[0-9]{4}$' ORDER BY fsc LIMIT 4`)).rows.map((r) => r.fsc);
  if (fscs.length < 3) throw new Error('seed needs at least 3 four-digit classes in pub.fsc');
  const agencies = (await client.query(`SELECT agency_id FROM pub.agencies ORDER BY agency_id LIMIT 3`)).rows.map((r) => r.agency_id);
  const nsnOf = (i) => `${fscs[i % fscs.length]}00${String(9000000 + i).padStart(7, '0')}`;
  for (let i = 0; i < 12; i += 1) {
    await client.query(`INSERT INTO pub.nsns (nsn, fsc) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nsnOf(i), fscs[i % fscs.length]]);
  }
  // [cage, awards[{daysAgo, nsnIdx, agencyIdx|null, total|null, unit, qty|null}]]
  const A = (daysAgo, nsnIdx, agencyIdx, total, unit = 10, qty = null) => ({ daysAgo, nsnIdx, agencyIdx, total, unit, qty });
  const suppliers = {
    // two suppliers with identical metrics: the tie goes to the lower CAGE
    T0001: [A(10, 0, 0, 5000), A(20, 1, 0, 5000), A(30, 2, 1, 1000)],
    T0002: [A(10, 0, 0, 5000), A(20, 1, 0, 5000), A(30, 2, 1, 1000)],
    // exactly $10,000 and exactly 3 awards in 12 months: qualifies for rising; prior year bigger (negative delta)
    T0003: [A(1, 3, 1, 4000), A(364, 3, 1, 3000), A(100, 4, 2, 3000), A(365, 4, 2, 20000), A(400, 5, 2, 1)],
    // 9,999.99 in 12m, 3 awards: does not qualify
    T0004: [A(1, 3, 1, 3333.33), A(2, 3, 1, 3333.33), A(3, 3, 1, 3333.33)],
    // $50,000 but only 2 awards: does not qualify
    T0005: [A(1, 6, 0, 25000), A(2, 6, 0, 25000)],
    // all older than 24 months: no 12m, no prior, still ranked in all-time
    T0006: [A(731, 7, 0, 777), A(900, 7, 0, 111)],
    // boundary days: 365 is prior (not 12m), 730 is prior's last day? 730 is NOT in prior (> CURRENT_DATE - 730)
    T0007: [A(364, 8, 1, 100), A(365, 8, 1, 200), A(729, 8, 1, 400), A(730, 8, 1, 800)],
    // unit_price x quantity fallback, and an award with neither (counts as a win, adds no dollars)
    T0008: [A(5, 9, null, null, 12.5, 4), A(6, 9, null, null, 7, null), A(7, 10, null, 600)],
    // zero dollars everywhere
    T0009: [A(5, 11, 2, null, 7, null)],
    // strong riser: prior year tiny
    T0010: [A(2, 0, 0, 90000), A(4, 1, 0, 90000), A(6, 2, 0, 90000), A(500, 0, 0, 100)],
    // a future-dated award (counts in the 12m window per the spec's literal definition)
    T0011: [A(-3, 2, 1, 250), A(1, 2, 1, 250), A(2, 2, 1, 250)],
  };
  let ref = 0;
  for (const [cage, awards] of Object.entries(suppliers)) {
    await client.query(`INSERT INTO pub.suppliers (cage, name, city, state) VALUES ($1, $2, 'Testville', 'TX')`, [cage, `TEST SUPPLIER ${cage}`]);
    for (const a of awards) {
      ref += 1;
      await client.query(
        `INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
         VALUES ($1, CURRENT_DATE - $2::int, $3, $4, $5, $6, $7, $8, 'dibbs_awd', 'https://www.dibbs.bsm.dla.mil/', '{}')`,
        [nsnOf(a.nsnIdx), a.daysAgo, a.unit, a.qty, a.total, cage, a.agencyIdx === null ? null : agencies[a.agencyIdx], `VERIFY-${ref}`]
      );
    }
  }
  return Object.keys(suppliers).length;
}

export async function verify(client, { withSeed = false } = {}) {
  await client.query('BEGIN');
  try {
    const seeded = withSeed ? await seed(client) : 0;
    const refreshed = Number((await client.query('SELECT pub.refresh_supplier_stats() AS n')).rows[0].n);
    const naive = (await client.query(NAIVE_SQL)).rows;
    const actual = (await client.query(ACTUAL_SQL)).rows;
    const exp = expectedRanks(naive);
    const mismatches = [];
    const note = (cage, col, want, got) => mismatches.push(`${cage} ${col}: expected ${want}, got ${got}`);

    if (naive.length !== actual.length || refreshed !== naive.length) {
      note('(all)', 'row count', `${naive.length} (function returned ${refreshed})`, actual.length);
    }
    const byCage = new Map(actual.map((r) => [r.cage, r]));
    const plain = ['awards_all', 'dollars_all', 'awards_12m', 'dollars_12m', 'awards_prior_12m', 'dollars_prior_12m', 'nsns', 'fscs', 'agencies', 'first_award', 'last_award'];
    const rankCols = ['rank_dollars_12m', 'rank_dollars_all', 'rank_wins_12m', 'rank_wins_all', 'rank_nsns', 'rank_fscs', 'rank_rising'];
    for (const n of naive) {
      const a = byCage.get(n.cage);
      if (!a) { note(n.cage, 'row', 'present', 'missing'); continue; }
      for (const c of plain) if (String(n[c]) !== String(a[c])) note(n.cage, c, n[c], a[c]);
      for (const c of rankCols) {
        const want = exp[c].get(n.cage) ?? null;
        if (want !== a[c]) note(n.cage, c, want, a[c]);
      }
      if (Number(a.rising_delta) !== exp.delta.get(n.cage)) note(n.cage, 'rising_delta', exp.delta.get(n.cage), a.rising_delta);
    }
    for (const a of actual) if (!naive.some((n) => n.cage === a.cage)) note(a.cage, 'row', 'absent', 'present');

    const total = naive.length * (plain.length + rankCols.length + 1);
    return { suppliers: naive.length, seeded, checks: total, mismatches };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const withSeed = process.argv.includes('--seed');
  const client = await getPool().connect();
  try {
    const r = await verify(client, { withSeed });
    console.log(`verified ${r.suppliers} supplier(s)${withSeed ? ` (${r.seeded} synthetic, rolled back)` : ''}, ${r.checks} value(s) compared`);
    for (const m of r.mismatches) console.log(`MISMATCH ${m}`);
    console.log(`${r.mismatches.length} mismatches`);
    if (r.mismatches.length) process.exitCode = 1;
  } finally {
    client.release();
    await closePool();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
