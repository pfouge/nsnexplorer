#!/usr/bin/env node
// ingest/probe/data-depth.mjs
// Measures, before anything is built, how much more price data is reachable:
//
//   1. DIBBS: for sample posting dates going back two years, does the award
//      grid and the RFQ grid still return rows? (First page only per date.)
//      A deeper price history needs BOTH for the same dates, because a unit
//      price comes from joining an award to its solicitation.
//   2. USAspending: how many contract awards exist per supply class over the
//      last 120 days, for the classes with the most open demand. Tells us what
//      widening beyond the two classes loaded today would cost in rows.
//   3. Database: table sizes, contract-action rows by source and class, and
//      how many stock numbers have 1, 2, 3+ priced purchases today.
//
// Read-only against the database. Writes ingest/probe/data-depth-report.json.
// Runs from GitHub Actions (DIBBS only answers US addresses).
//
// CLI:  node ingest/probe/data-depth.mjs [--out file.json]

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseAwardGrid, parseRfqGrid, parsePagination } from '../dibbs/parse.mjs';
import { getPool, closePool } from '../../shared/db.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(here, 'data-depth-report.json');

const DAYS_BACK = [10, 30, 60, 90, 120, 180, 270, 365, 545, 730];
const USA_WINDOW_DAYS = 120;
const USA_CLASSES = 40;

const iso = (d) => d.toISOString().slice(0, 10);
const mmddyyyy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;

/** The Wednesday on or before `daysBack` days ago: mid-week avoids weekends and most holidays. */
function sampleDate(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400000);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function probeDibbs(report) {
  const dates = DAYS_BACK.map((n) => ({ daysBack: n, date: sampleDate(n) }));
  const list = dates.map((d) => mmddyyyy(d.date)).join(',');
  report.dibbs = { note: 'first page of each grid only; pagesVisible is a lower bound (the pager shows a window)', samples: [] };
  for (const type of ['awd', 'rfq']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `depth-${type}-`));
    let log = '';
    try {
      const r = await run('node', [path.join(here, '../dibbs/fetch.mjs'), '--type', type, '--dates', list, '--max-pages', '1', '--out', dir], { maxBuffer: 16 * 1024 * 1024 });
      log = r.stdout + r.stderr;
    } catch (err) {
      log = `${err.stdout ?? ''}${err.stderr ?? ''}`; // a failed date exits 1; the files that did arrive still count
    }
    const files = await readdir(dir);
    for (const { daysBack, date } of dates) {
      const name = `${type}-${mmddyyyy(date)}-p1.html`;
      const entry = { type, daysBack, date: iso(date), fetched: files.includes(name) };
      if (entry.fetched) {
        const html = await readFile(path.join(dir, name), 'utf8');
        try {
          const rows = type === 'awd' ? parseAwardGrid(html) : parseRfqGrid(html);
          entry.rowsOnFirstPage = rows.length;
          const pages = parsePagination(html).pages.map((p) => Number(String(p).replace('Page$', ''))).filter(Number.isFinite);
          entry.pagesVisible = pages.length ? Math.max(...pages) : 1;
          entry.bytes = html.length;
          if (rows.length === 0) entry.textHint = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/.{0,80}(no records|not found|no data|0 records).{0,80}/i)?.[0] ?? null;
        } catch (err) {
          entry.parseError = String(err.message).slice(0, 200);
        }
      }
      report.dibbs.samples.push(entry);
    }
    report.dibbs[`${type}LogTail`] = log.split('\n').filter((l) => /failed|FAILED|dates fetched|banner/i.test(l)).slice(-12);
  }
}

async function usaCount(psc, start, end) {
  const res = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award_count/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters: {
        time_period: [{ start_date: start, end_date: end }],
        award_type_codes: ['A', 'B', 'C', 'D'],
        psc_codes: { require: [['Product', psc]] },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  return json.results?.contracts ?? null;
}

async function probeUsaspending(report, pool) {
  const end = new Date();
  const start = new Date(end.getTime() - USA_WINDOW_DAYS * 86400000);
  const top = await pool.query(
    `SELECT s.fsc, f.name, count(*)::int AS open
       FROM pub.solicitations s LEFT JOIN pub.fsc f ON f.fsc = s.fsc
      WHERE s.status = 'open' AND s.fsc ~ '^[0-9]{4}$'
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT $1`,
    [USA_CLASSES],
  );
  const classes = top.rows.map((r) => ({ fsc: r.fsc, name: r.name, open: r.open }));
  for (const fsc of ['5330', '5331']) if (!classes.some((c) => c.fsc === fsc)) classes.push({ fsc, name: null, open: null });
  report.usaspending = { windowDays: USA_WINDOW_DAYS, start: iso(start), end: iso(end), classes: [] };
  for (const c of classes) {
    try {
      c.contractsInWindow = await usaCount(c.fsc, iso(start), iso(end));
    } catch (err) {
      c.error = String(err.message).slice(0, 200);
    }
    report.usaspending.classes.push(c);
    await new Promise((r) => setTimeout(r, 400));
  }
  const counted = report.usaspending.classes.filter((c) => Number.isFinite(c.contractsInWindow));
  report.usaspending.totalContractsInWindow = counted.reduce((n, c) => n + c.contractsInWindow, 0);
}

async function probeDatabase(report, pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  report.database = {
    tables: await q(
      `SELECT c.relname AS table, pg_total_relation_size(c.oid)::bigint AS bytes, c.reltuples::bigint AS approx_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pub' AND c.relkind = 'r' ORDER BY 2 DESC`,
    ),
    databaseBytes: (await q(`SELECT pg_database_size(current_database())::bigint AS bytes`))[0].bytes,
    contractActionsBySource: await q(
      `SELECT CASE WHEN award_uid LIKE 'DIBBS-%' THEN 'dibbs' ELSE 'usaspending' END AS source,
              count(*)::int AS rows, round(avg(pg_column_size(raw)))::int AS avg_raw_bytes,
              min(action_date)::text AS earliest, max(action_date)::text AS latest
         FROM pub.contract_actions GROUP BY 1`,
    ),
    usaspendingByClass: await q(
      `SELECT psc, count(*)::int AS rows FROM pub.contract_actions WHERE award_uid NOT LIKE 'DIBBS-%' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    ),
    dibbsAwardsByMonth: await q(
      `SELECT to_char(action_date, 'YYYY-MM') AS month, count(*)::int AS rows FROM pub.contract_actions
        WHERE award_uid LIKE 'DIBBS-%' GROUP BY 1 ORDER BY 1`,
    ),
    solicitationsByIssuedMonth: await q(
      `SELECT to_char(issued_on, 'YYYY-MM') AS month, source, count(*)::int AS rows FROM pub.solicitations GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    pricePointsByMonth: await q(`SELECT to_char(awarded_on, 'YYYY-MM') AS month, count(*)::int AS rows FROM pub.price_points GROUP BY 1 ORDER BY 1`),
    pricedPurchasesPerNsn: (
      await q(
        `SELECT count(*) FILTER (WHERE n >= 1)::int AS with_1_plus, count(*) FILTER (WHERE n >= 2)::int AS with_2_plus,
                count(*) FILTER (WHERE n >= 3)::int AS with_3_plus, count(*) FILTER (WHERE n >= 5)::int AS with_5_plus
           FROM (SELECT nsn, count(*) AS n FROM pub.price_points GROUP BY 1) t`,
      )
    )[0],
    nsns: (await q(`SELECT count(*)::int AS n FROM pub.nsns`))[0].n,
    amscObservations: await q(`SELECT source, count(*)::int AS rows, count(DISTINCT nsn)::int AS nsns FROM pub.amsc_observations GROUP BY 1`),
    amcDistribution: await q(`SELECT amc, count(*)::int AS rows FROM pub.amsc_observations GROUP BY 1 ORDER BY 2 DESC LIMIT 12`),
    amscDistribution: await q(`SELECT amsc, count(*)::int AS rows FROM pub.amsc_observations GROUP BY 1 ORDER BY 2 DESC LIMIT 30`),
  };
}

const report = { at: new Date().toISOString(), errors: {} };
const pool = getPool();
for (const [name, fn] of [['database', () => probeDatabase(report, pool)], ['usaspending', () => probeUsaspending(report, pool)], ['dibbs', () => probeDibbs(report)]]) {
  try {
    await fn();
  } catch (err) {
    report.errors[name] = String(err.stack ?? err).slice(0, 600); // one part failing must not lose the others
  }
}
await closePool();
await writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`data-depth: wrote ${OUT}`);
console.log(JSON.stringify({ errors: report.errors, dibbsSamples: report.dibbs?.samples?.length ?? 0, usaClasses: report.usaspending?.classes?.length ?? 0 }));
