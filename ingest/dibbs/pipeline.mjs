#!/usr/bin/env node
// ingest/dibbs/pipeline.mjs
// Glue CLI wired into .github/workflows/ingest-daily.yml's DIBBS
// parse+load step. Two modes:
//
//   --type awd  reads every fetched award-grid .html page in --dir (written
//               by fetch.mjs as awd-MM-DD-YYYY-pN.html), parses each with
//               parse.mjs's parseAwardGrid, and loads the concatenated
//               records with load.mjs's loadAwardGridActions.
//
//   --type rfq  reads every fetched RFQ-grid .html page in --dir (written
//               by fetch.mjs as rfq-MM-DD-YYYY-pN.html), parses each with
//               parse.mjs's parseRfqGrid, loads the concatenated records
//               with load.mjs's loadRfqSolicitations (ALL currently-open
//               DIBBS RFQ solicitations, across the entire catalog — see
//               db/migrations/0003_open_solicitations.sql), and then
//               reconciles pub.solicitations with load.mjs's
//               reconcileOpenSolicitations.
//
// LIVE (awd): the totals-only load path is live. DIBBS award-grid rows
// carry total contract price but no unit price, so they load as
// pub.contract_actions (award totals) — not pub.price_points, which stays
// reserved for true unit prices. See docs/dibbs-ingest-findings.md "Award
// grid — CONFIRMED" and ingest/dibbs/load.mjs's module header.
//
// FUTURE WORK: unit prices arrive later via a join against the RFQ grid's
// quantity column (RfqRecs.aspx mirrors AwdRecs.aspx) and will load into
// pub.price_points through loadAwardRecords, which stays gated on
// parse.mjs's LAYOUT_CONFIRMED until that join is implemented.
//
// CLI:
//   node pipeline.mjs --type awd --dir ingest/dibbs/tmp/awd
//   node pipeline.mjs --type rfq --dir ingest/dibbs/tmp/rfq [--reconcile]
//
// --reconcile marks this run as a full-window recrawl of every currently
// open solicitation, so reconcileOpenSolicitations may cancel 'open' rows
// not re-observed this run (mode 'full'). Without it (the default —
// 'expiry-only'), reconciliation only flips past-return_by rows to
// 'expired' and never cancels on absence, since a partial/incremental crawl
// (e.g. "today's postings only") not revisiting a row says nothing about
// whether DIBBS still lists it.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseAwardGrid, parseRfqGrid } from './parse.mjs';
import { loadAwardGridActions, loadRfqSolicitations, reconcileOpenSolicitations } from './load.mjs';
import { getPool } from '../../shared/db.mjs';

function parseArgs(argv) {
  const args = { type: undefined, dir: undefined, reconcile: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--type') args.type = argv[++i];
    else if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--reconcile') args.reconcile = true;
  }
  if (!['awd', 'rfq'].includes(args.type)) {
    throw new Error("pipeline.mjs: --type must be 'awd' or 'rfq'");
  }
  if (!args.dir) throw new Error('pipeline.mjs: --dir is required');
  return args;
}

async function runAwd(args) {
  const files = (await readdir(args.dir)).filter((f) => f.toLowerCase().endsWith('.html'));
  if (files.length === 0) {
    console.log(`pipeline.mjs: no .html files found in ${args.dir}`);
    return;
  }

  const allRecords = [];
  for (const filename of files) {
    const html = await readFile(path.join(args.dir, filename), 'utf8');
    const { records } = parseAwardGrid(html);
    allRecords.push(...records);
  }

  const result = await loadAwardGridActions(allRecords);
  const reasons = {};
  for (const s of result.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  console.log(
    `pipeline.mjs: ${files.length} files, ${allRecords.length} parsed records, ` +
      `${result.loaded} loaded, ${result.skipped.length} skipped`
  );
  console.log('pipeline.mjs skip reasons:', JSON.stringify(reasons));
}

async function runRfq(args) {
  const crawlStartedAt = new Date().toISOString();

  const files = (await readdir(args.dir)).filter(
    (f) => f.toLowerCase().startsWith('rfq-') && f.toLowerCase().endsWith('.html')
  );
  if (files.length === 0) {
    console.log(`pipeline.mjs: no rfq-*.html files found in ${args.dir}`);
    return;
  }

  const allRecords = [];
  for (const filename of files) {
    const html = await readFile(path.join(args.dir, filename), 'utf8');
    const { records } = parseRfqGrid(html);
    allRecords.push(...records);
  }

  const today = crawlStartedAt.slice(0, 10);
  const pool = getPool();
  const loadResult = await loadRfqSolicitations(allRecords, { pool, today });

  const mode = args.reconcile ? 'full' : 'expiry-only';
  const reconcileResult = await reconcileOpenSolicitations({ pool, mode, crawlStartedAt });

  console.log(
    `pipeline.mjs: ${files.length} files, ${allRecords.length} parsed records, ` +
      `${loadResult.loaded} loaded, ${loadResult.skipped} skipped ` +
      `${JSON.stringify(loadResult.skipReasons)}`
  );
  console.log(
    `pipeline.mjs: reconcile (mode=${mode}) — ${reconcileResult.expired} expired, ` +
      `${reconcileResult.cancelled} cancelled`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.type === 'awd') {
    await runAwd(args);
  } else {
    await runRfq(args);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
