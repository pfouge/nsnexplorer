#!/usr/bin/env node
// ingest/usaspending/load.mjs
// Loads a JSONL file of raw USAspending spending_by_award records (as
// written by fetch.mjs) into pub.agencies, pub.fsc, pub.nsns and
// pub.contract_actions.
//
// IMPORTANT: USAspending's spending_by_award endpoint carries no unit-price
// field, so this loader NEVER writes to pub.price_points.
//
// CLI:
//   node load.mjs --file x.jsonl --psc 5331

import { readFile } from 'node:fs/promises';
import { tx, upsert } from '../../shared/db.mjs';
import { extractNiin, extractNsn } from '../../shared/nsn.mjs';

// Small built-in FSC name map. Anything else falls back to 'FSC <code>' —
// see docs: FSC rows are also created/kept by publog loads with fuller data.
export const FSC_NAMES = {
  '5331': 'O-Rings',
  '5330': 'Packing and Gasket Materials',
  '5306': 'Bolts',
  '5305': 'Screws',
};

export function fscName(psc) {
  return FSC_NAMES[psc] || `FSC ${psc}`;
}

function isValidFscCode(psc) {
  return typeof psc === 'string' && /^\d{4}$/.test(psc);
}

export function itemNameFromDescription(description) {
  if (!description) return null;
  const idx = description.indexOf('!');
  if (idx === -1) return null;
  const name = description.slice(idx + 1).trim();
  return name || null;
}

function parseArgs(argv) {
  const args = { file: undefined, psc: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--psc') args.psc = argv[++i];
  }
  if (!args.file) throw new Error('load.mjs: --file is required');
  if (!args.psc) throw new Error('load.mjs: --psc is required');
  return args;
}

async function ensureFsc(client, psc) {
  // Service PSCs (letters, e.g. J028) are not supply classes: keep the row
  // for the FK but never render it as a category (migration 0006).
  const renderDepth = isValidFscCode(psc) ? 'deep' : 'excluded';
  await client.query(
    `INSERT INTO pub.fsc (fsc, name, render_depth) VALUES ($1, $2, $3) ON CONFLICT (fsc) DO NOTHING`,
    [psc, fscName(psc), renderDepth]
  );
}

/**
 * Finds or creates a pub.agencies row for a (toptier name, subtier name)
 * pair. USAspending's spending_by_award endpoint (with the field set this
 * project requests) returns agency *names* only, not codes, so we cannot
 * rely on the table's (toptier_code, subtier_code) unique constraint for
 * ON CONFLICT — with both codes null for every such row, Postgres'
 * NULLS NOT DISTINCT would incorrectly collide every agency into one row.
 * Instead this does a plain find-by-name-then-insert, matching only rows
 * that also have null codes (i.e. rows created the same way).
 */
export async function upsertAgency(client, { toptierName, subtierName }) {
  const name = subtierName || toptierName;
  if (!name) return null;

  const existing = await client.query(
    `SELECT agency_id FROM pub.agencies
     WHERE name = $1 AND toptier_code IS NULL AND subtier_code IS NULL
     LIMIT 1`,
    [name]
  );
  if (existing.rowCount > 0) return existing.rows[0].agency_id;

  const inserted = await client.query(
    `INSERT INTO pub.agencies (toptier_code, subtier_code, name)
     VALUES (NULL, NULL, $1)
     RETURNING agency_id`,
    [name]
  );
  return inserted.rows[0].agency_id;
}

function parseDate(s) {
  if (!s) return null;
  const d = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Loads one raw USAspending record inside its own transaction. Returns a
 * summary of what was written, useful for tests/CLI logging.
 */
/**
 * Field access tolerant of both naming schemes: the live API "fields" names
 * ('Description', 'Award Amount', ...) and the snake_case names produced by
 * MCP/bulk dumps ('description', 'amount', ...).
 */
function field(record, ...names) {
  for (const n of names) {
    if (record[n] !== undefined && record[n] !== null && record[n] !== '') return record[n];
  }
  return null;
}

export async function loadRecord(record, psc) {
  return tx(async (client) => {
    await ensureFsc(client, psc);

    const agencyId = await upsertAgency(client, {
      toptierName: field(record, 'Awarding Agency', 'awarding_agency'),
      subtierName: field(record, 'Awarding Sub Agency', 'awarding_sub_agency'),
    });

    const description = field(record, 'Description', 'description') || '';
    // A full NSN in the description is authoritative (its own FSC wins);
    // only a bare NIIN gets combined with the record's PSC.
    let nsn = extractNsn(description);
    if (!nsn) {
      const niin = extractNiin(description);
      if (isValidFscCode(psc) && niin && /^\d{9}$/.test(niin)) {
        nsn = `${psc}${niin}`;
      }
    }
    if (nsn) {
      const nsnFsc = nsn.slice(0, 4);
      await ensureFsc(client, nsnFsc);
      const nsnRow = { nsn, fsc: nsnFsc };
      const itemName = itemNameFromDescription(description);
      if (itemName) nsnRow.item_name = itemName;
      await upsert('pub.nsns', ['nsn'], nsnRow, { client });
    }

    const awardUid = record['generated_internal_id'];
    if (!awardUid) {
      throw new Error('loadRecord: record missing generated_internal_id');
    }

    const raw = nsn ? { ...record, nsn } : record;

    const res = await client.query(
      `INSERT INTO pub.contract_actions
         (award_uid, piid, psc, naics, description, action_date, obligation,
          agency_id, recipient_name, recipient_uei, source_url, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (award_uid, action_date) DO NOTHING
       RETURNING id`,
      [
        awardUid,
        field(record, 'Award ID', 'award_id'),
        psc,
        null,
        description || null,
        parseDate(field(record, 'Start Date', 'start_date')),
        parseAmount(field(record, 'Award Amount', 'amount')),
        agencyId,
        field(record, 'Recipient Name', 'recipient'),
        field(record, 'recipient_uei'),
        `https://www.usaspending.gov/award/${awardUid}`,
        JSON.stringify(raw),
      ]
    );

    return { awardUid, nsn, inserted: res.rowCount > 0 };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = await readFile(args.file, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let inserted = 0;
  let skipped = 0;
  let withNsn = 0;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      console.error(`load.mjs: skipping unparseable line: ${err.message}`);
      skipped += 1;
      continue;
    }
    const result = await loadRecord(record, args.psc);
    if (result.inserted) inserted += 1;
    else skipped += 1;
    if (result.nsn) withNsn += 1;
  }

  console.log(
    `load.mjs: ${lines.length} record(s) read, ${inserted} inserted, ${skipped} skipped (dupes/errors), ${withNsn} with parsed NSN`
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
