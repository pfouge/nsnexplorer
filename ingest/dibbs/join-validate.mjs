#!/usr/bin/env node
// ingest/dibbs/join-validate.mjs
// Pure, DB-free VALIDATOR for the award<->RFQ unit-price join: the DIBBS
// award grid (parseAwardGrid, see parse.mjs) publishes a total contract
// price but never quantity or unit price; the DIBBS RFQ grid
// (parseRfqGrid) publishes quantity but never a price. Joining an award to
// the RFQ it was awarded against (by Solicitation + PurchaseRequest) lets
// us derive unitPrice = award.total / rfq.quantity — this module checks
// how well that join actually works against real captured pages, without
// writing anything to a database. It is diagnostic tooling, not a loader.
//
// NOTE (found while building this against the committed fixtures): the
// award grid's Solicitation cell has no dashes (e.g. 'SPE7L726T2303')
// while the RFQ grid's Solicitation cell is dash-formatted (e.g.
// 'SPE1C1-26-Q-0372') for the *same* underlying solicitation number. This
// module therefore normalizes both sides to uppercase alphanumerics
// before comparing (see joinKey),
// so a real award/RFQ pair from the same date will NOT match unless the
// dash formatting happens to agree. Left as-is intentionally rather than
// silently normalizing a join key the spec defined explicitly — but this
// is very likely why match_rate will read near-zero against real fetched
// data, and is worth fixing (e.g. compare with dashes stripped from both
// sides) before this validator is trusted for anything beyond smoke
// testing. See ingest/dibbs/rfq-parse.test.mjs's join smoke test and
// docs/dibbs-ingest-findings.md.
//
// CLI:
//   node join-validate.mjs --awd-dir dir/ --rfq-dir dir/ --out report.json [--now 2026-07-17T00:00:00.000Z]
//
// Reads every *.html file in --awd-dir with parseAwardGrid and every
// *.html file in --rfq-dir with parseRfqGrid, joins them (joinAwardRfq,
// exported as a pure function for testing), and writes a JSON report to
// --out. No network, no database — pure files in, JSON out.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAwardGrid, parseRfqGrid } from './parse.mjs';

function parseArgs(argv) {
  const args = { awdDir: undefined, rfqDir: undefined, out: undefined, now: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--awd-dir') args.awdDir = argv[++i];
    else if (a === '--rfq-dir') args.rfqDir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--now') args.now = argv[++i];
  }
  if (!args.awdDir) throw new Error('join-validate.mjs: --awd-dir is required');
  if (!args.rfqDir) throw new Error('join-validate.mjs: --rfq-dir is required');
  if (!args.out) throw new Error('join-validate.mjs: --out is required');
  return args;
}

/** Lists every *.html file in `dir` (sorted, for deterministic output). */
async function listHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.html'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Parses every award grid page in `dir` and concatenates their records. */
async function parseAllAwards(dir) {
  const files = await listHtmlFiles(dir);
  const records = [];
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    const { records: pageRecords } = parseAwardGrid(html);
    records.push(...pageRecords);
  }
  return records;
}

/** Parses every RFQ grid page in `dir` and concatenates their records. */
async function parseAllRfqs(dir) {
  const files = await listHtmlFiles(dir);
  const records = [];
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    const { records: pageRecords } = parseRfqGrid(html);
    records.push(...pageRecords);
  }
  return records;
}

/**
 * Normalizes a solicitation-number-like token to uppercase alphanumerics
 * only (drops dashes/spaces/punctuation). Exported because the same
 * normalization is what makes the award<->pub.solicitations price join in
 * load.mjs's loadPricePointsFromAwards work: the award grid's Solicitation
 * cell is dashless (e.g. 'SPE7L726T2303') while pub.solicitations stores
 * the dashed form (e.g. 'SPE7L7-26-T-2303') for the same underlying number.
 */
export function norm(v) {
  return String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Join key: Solicitation + PurchaseRequest, the pair the DIBBS award page inherits from its RFQ. */
// Solicitation numbers appear dashless on the award grid and dashed on
// the RFQ grid for the same underlying number, so the key normalizes
// both sides to uppercase alphanumerics.
function joinKey(solicitation, purchaseRequest) {
  return `${norm(solicitation)}|${norm(purchaseRequest)}`;
}

/**
 * Classifies a joined award/rfq pair. unitPrice is only meaningful when
 * both quantity and total are positive finite numbers; otherwise it's left
 * null and the missing/invalid input is called out in `reasons`.
 */
function classifyJoin(award, rfq) {
  const { total } = award;
  const { quantity } = rfq;
  const reasons = [];

  const quantityOk = typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0;
  const totalOk = typeof total === 'number' && Number.isFinite(total) && total > 0;

  if (!quantityOk) reasons.push(`rfq quantity (${JSON.stringify(quantity)}) is not a positive number`);
  if (!totalOk) reasons.push(`award total (${JSON.stringify(total)}) is not a positive number`);

  let unitPrice = null;
  if (quantityOk && totalOk) {
    unitPrice = total / quantity;
    if (!(unitPrice > 0 && unitPrice <= total)) {
      reasons.push(`unitPrice (${unitPrice}) is not in the range (0, total=${total}]`);
    }
  }

  return { ok: reasons.length === 0, unitPrice, reasons };
}

/**
 * Pure join + classification logic — no I/O. Joins `awards` (parseAwardGrid
 * records) to `rfqs` (parseRfqGrid records) on solicitation + purchaseRequest
 * (both must be non-null) and classifies every award record into exactly
 * one of matched_ok / matched_implausible / unmatched_award, and separately
 * counts rfq_unmatched (RFQ records no award ever joined to).
 *
 * @param {object[]} awards parseAwardGrid records
 * @param {object[]} rfqs parseRfqGrid records
 * @returns {{
 *   matched_ok: object[], matched_implausible: object[], unmatched_award: object[],
 *   rfq_unmatched: number,
 *   totals: { awards: number, rfqs: number, matched_ok: number, matched_implausible: number, unmatched_award: number, rfq_unmatched: number },
 * }}
 */
export function joinAwardRfq(awards, rfqs) {
  const rfqByKey = new Map(); // joinKey -> rfq record[]
  for (const rfq of rfqs) {
    if (rfq.solicitation == null || rfq.purchaseRequest == null) continue;
    const key = joinKey(rfq.solicitation, rfq.purchaseRequest);
    if (!rfqByKey.has(key)) rfqByKey.set(key, []);
    rfqByKey.get(key).push(rfq);
  }

  const usedRfqKeys = new Set();
  const matched_ok = [];
  const matched_implausible = [];
  const unmatched_award = [];

  for (const award of awards) {
    const canJoin = award.solicitation != null && award.purchaseRequest != null;
    const key = canJoin ? joinKey(award.solicitation, award.purchaseRequest) : null;
    const rfqMatches = key ? rfqByKey.get(key) : undefined;

    if (!rfqMatches || rfqMatches.length === 0) {
      unmatched_award.push(award);
      continue;
    }

    usedRfqKeys.add(key);
    // Multiple RFQ rows can share the same solicitation+PR (e.g. a
    // resubmitted line); the first one wins, matching how the award grid
    // itself dedupes purchase requests within a solicitation.
    const rfq = rfqMatches[0];
    const { ok, unitPrice, reasons } = classifyJoin(award, rfq);

    const entry = {
      nsn: award.nsnRaw,
      solicitation: award.solicitation,
      pr: award.purchaseRequest,
      total: award.total,
      quantity: rfq.quantity,
      unitPrice,
    };

    if (ok) {
      matched_ok.push(entry);
    } else {
      matched_implausible.push({ ...entry, reasons });
    }
  }

  let rfq_unmatched = 0;
  for (const [key, list] of rfqByKey) {
    if (!usedRfqKeys.has(key)) rfq_unmatched += list.length;
  }

  return {
    matched_ok,
    matched_implausible,
    unmatched_award,
    rfq_unmatched,
    totals: {
      awards: awards.length,
      rfqs: rfqs.length,
      matched_ok: matched_ok.length,
      matched_implausible: matched_implausible.length,
      unmatched_award: unmatched_award.length,
      rfq_unmatched,
    },
  };
}

/** Builds the JSON report object written to --out. */
function buildReport(awards, rfqs, at) {
  const joined = joinAwardRfq(awards, rfqs);
  const totalAwards = joined.totals.awards;
  const match_rate = totalAwards > 0 ? joined.totals.matched_ok / totalAwards : 0;

  return {
    at,
    totals: joined.totals,
    match_rate,
    unmatchedSample: {
      awards: joined.unmatched_award.slice(0, 12).map((a) => ({
        solicitation: a.solicitation, pr: a.purchaseRequest, nsn: a.nsnRaw ?? a.nsn ?? null,
      })),
      rfqs: rfqs.slice(0, 12).map((r) => ({
        solicitation: r.solicitation, pr: r.purchaseRequest, status: r.status,
      })),
    },
    sample: {
      matched_ok: joined.matched_ok.slice(0, 20),
      matched_implausible: joined.matched_implausible.slice(0, 10),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const [awards, rfqs] = await Promise.all([
    parseAllAwards(args.awdDir),
    parseAllRfqs(args.rfqDir),
  ]);

  // --now lets CI/tests pin `at` for reproducible output; Date.now() is
  // fine otherwise since this always runs on a runner, never client-side.
  const at = args.now || new Date().toISOString();
  const report = buildReport(awards, rfqs, at);

  await writeFile(args.out, JSON.stringify(report, null, 2), 'utf8');

  const t = report.totals;
  console.log(
    `join-validate.mjs: ${t.awards} awards / ${t.rfqs} rfqs -> ` +
    `matched_ok=${t.matched_ok} matched_implausible=${t.matched_implausible} ` +
    `unmatched_award=${t.unmatched_award} rfq_unmatched=${t.rfq_unmatched} ` +
    `match_rate=${(report.match_rate * 100).toFixed(1)}% -> wrote ${args.out}`
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
