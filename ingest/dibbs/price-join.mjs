#!/usr/bin/env node
// ingest/dibbs/price-join.mjs
// Continuous award->RETAINED-solicitation price-join CLI. Parses every
// award-grid *.html page in --dir (written by fetch.mjs --type awd) with
// parse.mjs's parseAwardGrid, then joins the parsed records against the
// PERSISTED pub.solicitations table (not a freshly-crawled RFQ set — see
// load.mjs's loadPricePointsFromAwards header for why that's the fix over
// the old join-validate.mjs approach) and upserts unit prices into
// pub.price_points.
//
// This is deliberately a separate script from pipeline.mjs's --type awd
// path: that path loads award totals into pub.contract_actions (context
// layer, no unit price). This script is the price-history lane — it does
// NOT also load contract_actions, so callers that want both run both
// scripts against the same fetched --dir (see
// .github/workflows/rfq-award-join.yml, which runs this alongside the
// existing ingest-daily.yml contract_actions lane).
//
// CLI:
//   node price-join.mjs --dir /tmp/awd

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseAwardGrid } from './parse.mjs';
import { loadPricePointsFromAwards } from './load.mjs';
import { getPool } from '../../shared/db.mjs';

function parseArgs(argv) {
  const args = { dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
  }
  if (!args.dir) throw new Error('price-join.mjs: --dir is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const files = (await readdir(args.dir)).filter(
    (f) => f.toLowerCase().startsWith('awd-') && f.toLowerCase().endsWith('.html')
  );
  if (files.length === 0) {
    console.log(`price-join.mjs: no awd-*.html files found in ${args.dir}`);
    return;
  }

  const allRecords = [];
  for (const filename of files) {
    const html = await readFile(path.join(args.dir, filename), 'utf8');
    const { records } = parseAwardGrid(html);
    allRecords.push(...records);
  }

  const pool = getPool();
  const result = await loadPricePointsFromAwards(allRecords, { pool });

  console.log(
    `price-join.mjs: ${files.length} files, ${allRecords.length} parsed award records -> ` +
      `matched=${result.matched} loaded=${result.loaded} skipped=${result.skipped} ` +
      `${JSON.stringify(result.skipReasons)}`
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
