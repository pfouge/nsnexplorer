#!/usr/bin/env node
// db/freshness.mjs
// Per-source freshness + classification report. Answers one question from
// the database itself, not from workflow status: "when did each data source
// last actually land rows, and is every row classified?" A lane can be green
// in Actions and still load nothing (an empty window, a skipped step), so
// this is the check that the pipeline is really on autopilot.
//
// Writes freshness.json (see .github/workflows/freshness.yml, which commits
// it) and exits 1 when any source is older than its limit or a
// classification invariant is broken, so the scheduled run fails and GitHub
// emails the repo owner. Sources marked warnOnly are reported but never fail
// the run.
//
// CLI:
//   node db/freshness.mjs [--out freshness.json] [--no-fail]

import { writeFileSync } from 'node:fs';
import { getPool, closePool } from '../shared/db.mjs';

// Hours a source may go without landing anything before it counts as stale.
// DIBBS posts awards on business days only, so the award lanes get a long
// weekend's slack; USAspending publishes DoD awards ~90 days late and in
// bursts, so it is checked weekly.
export const SOURCES = [
  {
    key: 'dibbs_rfq',
    label: 'DIBBS open solicitations (rfq-fast, rfq-reconcile)',
    maxAgeHours: 48,
    sql: `SELECT max(last_seen_at) AS last_landed, max(issued_on)::text AS newest_record,
                 count(*) AS rows, count(*) FILTER (WHERE status = 'open') AS open_rows
          FROM pub.solicitations WHERE source = 'dibbs_rfq'`,
  },
  {
    key: 'sam_gov',
    label: 'SAM.gov solicitations (sam-daily)',
    maxAgeHours: 48,
    sql: `SELECT max(last_seen_at) AS last_landed, max(issued_on)::text AS newest_record,
                 count(*) AS rows, count(*) FILTER (WHERE status = 'open') AS open_rows
          FROM pub.solicitations WHERE source = 'sam_gov'`,
  },
  {
    key: 'dibbs_awards',
    label: 'DIBBS award totals (ingest-daily)',
    maxAgeHours: 120,
    sql: `SELECT max(ingested_at) AS last_landed, max(action_date)::text AS newest_record, count(*) AS rows
          FROM pub.contract_actions WHERE award_uid LIKE 'DIBBS-%'`,
  },
  {
    key: 'price_points',
    label: 'Unit prices from award/solicitation join (ingest-daily, rfq-award-join)',
    maxAgeHours: 120,
    sql: `SELECT max(ingested_at) AS last_landed, max(awarded_on)::text AS newest_record, count(*) AS rows
          FROM pub.price_points`,
  },
  {
    key: 'usaspending',
    label: 'USAspending contract actions (ingest-daily)',
    maxAgeHours: 24 * 14,
    warnOnly: true, // publication is bursty; report it, don't page on it
    sql: `SELECT max(ingested_at) AS last_landed, max(action_date)::text AS newest_record, count(*) AS rows
          FROM pub.contract_actions WHERE award_uid NOT LIKE 'DIBBS-%'`,
  },
  {
    key: 'publog',
    label: 'PUB LOG / FLIS enrichment (publog-nightly)',
    maxAgeHours: 48,
    sql: `SELECT max(updated_at) FILTER (WHERE characteristics IS NOT NULL) AS last_landed,
                 NULL::text AS newest_record, count(*) AS rows,
                 count(*) FILTER (WHERE item_name IS NOT NULL) AS with_item_name,
                 count(*) FILTER (WHERE characteristics IS NOT NULL) AS with_characteristics
          FROM pub.nsns`,
  },
  {
    key: 'scoring',
    label: 'Target scoring (ingest-daily)',
    maxAgeHours: 72,
    warnOnly: true, // internal table, not shown on the site
    sql: `SELECT max(scored_at) AS last_landed, NULL::text AS newest_record, count(*) AS rows FROM ops.targets`,
  },
];

// Classification invariants: each query counts rows that break the rule, so
// every one of these should be 0. `fail: false` entries are reported only.
export const CHECKS = [
  {
    key: 'nsn_fsc_mismatch',
    label: 'NSNs whose stored FSC is not the first four digits of the NSN',
    fail: true,
    sql: `SELECT count(*) AS n FROM pub.nsns WHERE fsc <> left(nsn, 4)`,
  },
  {
    key: 'service_code_not_excluded',
    label: 'Letter-code (service) classes not marked excluded',
    fail: true,
    sql: `SELECT count(*) AS n FROM pub.fsc WHERE fsc !~ '^[0-9]{4}$' AND render_depth <> 'excluded'`,
  },
  {
    key: 'open_past_due',
    label: 'Solicitations still marked open after their return-by date',
    fail: true,
    sql: `SELECT count(*) AS n FROM pub.solicitations
          WHERE status = 'open' AND return_by IS NOT NULL AND return_by < CURRENT_DATE - 1`,
  },
  {
    key: 'dibbs_rfq_fsc_mismatch',
    label: 'DIBBS solicitations whose FSC disagrees with their NSN',
    fail: true,
    sql: `SELECT count(*) AS n FROM pub.solicitations
          WHERE source = 'dibbs_rfq' AND nsn IS NOT NULL AND fsc IS DISTINCT FROM left(nsn, 4)`,
  },
  {
    key: 'price_point_without_supplier',
    label: 'Price points whose CAGE has no supplier row',
    fail: true,
    sql: `SELECT count(*) AS n FROM pub.price_points p
          WHERE p.cage IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pub.suppliers s WHERE s.cage = p.cage)`,
  },
  {
    key: 'unlisted_classes',
    label: 'Supply classes with no handbook name (shown as "Unlisted supply class")',
    fail: false,
    sql: `SELECT count(*) AS n FROM pub.fsc WHERE fsc ~ '^[0-9]{4}$' AND name LIKE 'FSC %'`,
  },
  {
    key: 'sam_open_unclassified',
    label: 'Open SAM.gov notices with no product supply class (services or uncoded)',
    fail: false,
    sql: `SELECT count(*) AS n FROM pub.solicitations
          WHERE source = 'sam_gov' AND status = 'open' AND (fsc IS NULL OR fsc !~ '^[0-9]{4}$')`,
  },
  {
    key: 'nsns_without_item_name',
    label: 'NSNs with no item name yet',
    fail: false,
    sql: `SELECT count(*) AS n FROM pub.nsns WHERE item_name IS NULL`,
  },
  {
    key: 'suppliers_without_name',
    label: 'Supplier CAGE stubs awaiting PUB LOG name/address',
    fail: false,
    sql: `SELECT count(*) AS n FROM pub.suppliers WHERE name IS NULL`,
  },
];

/** Pure: turns one source's query row into a report entry. */
export function evaluateSource(source, row, now = new Date()) {
  const last = row?.last_landed ? new Date(row.last_landed) : null;
  const ageHours = last ? Math.round(((now - last) / 3600000) * 10) / 10 : null;
  const stale = ageHours === null || ageHours > source.maxAgeHours;
  const extra = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (!['last_landed', 'newest_record', 'rows'].includes(k)) extra[k] = Number(v);
  }
  return {
    source: source.key,
    label: source.label,
    last_landed: last ? last.toISOString() : null,
    age_hours: ageHours,
    max_age_hours: source.maxAgeHours,
    newest_record: row?.newest_record ?? null,
    rows: Number(row?.rows ?? 0),
    ...extra,
    status: stale ? (source.warnOnly ? 'warn' : 'STALE') : 'ok',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx === -1 ? 'freshness.json' : argv[outIdx + 1];
  const noFail = argv.includes('--no-fail');

  const pool = getPool();
  const now = new Date();

  const sources = [];
  for (const source of SOURCES) {
    const { rows } = await pool.query(source.sql);
    sources.push(evaluateSource(source, rows[0], now));
  }

  const checks = [];
  for (const check of CHECKS) {
    const { rows } = await pool.query(check.sql);
    const n = Number(rows[0].n);
    checks.push({
      check: check.key,
      label: check.label,
      count: n,
      status: check.fail ? (n === 0 ? 'ok' : 'FAIL') : 'info',
    });
  }

  const { rows: byDepth } = await pool.query(
    `SELECT f.render_depth, count(DISTINCT f.fsc) AS classes, count(n.nsn) AS nsns
     FROM pub.fsc f LEFT JOIN pub.nsns n ON n.fsc = f.fsc GROUP BY 1 ORDER BY 1`
  );

  await closePool();

  const problems = [
    ...sources.filter((s) => s.status === 'STALE').map((s) => `${s.source} stale (${s.age_hours === null ? 'never landed' : s.age_hours + 'h'}, limit ${s.max_age_hours}h)`),
    ...checks.filter((c) => c.status === 'FAIL').map((c) => `${c.check}: ${c.count}`),
  ];

  const report = {
    at: now.toISOString(),
    ok: problems.length === 0,
    problems,
    sources,
    checks,
    classes_by_render_depth: byDepth.map((r) => ({
      render_depth: r.render_depth,
      classes: Number(r.classes),
      nsns: Number(r.nsns),
    })),
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

  for (const s of sources) {
    console.log(`${s.status.padEnd(5)} ${s.source.padEnd(13)} last landed ${s.last_landed ?? 'never'} (${s.age_hours ?? '-'}h, limit ${s.max_age_hours}h) rows=${s.rows}`);
  }
  for (const c of checks) console.log(`${c.status.padEnd(5)} ${c.check}: ${c.count}`);
  if (problems.length) {
    console.error(`freshness: ${problems.length} problem(s): ${problems.join('; ')}`);
    if (!noFail) process.exitCode = 1;
  } else {
    console.log('freshness: all sources current, all classification checks clean');
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
