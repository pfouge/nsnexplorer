#!/usr/bin/env node
// ingest/usaspending/load.mjs
// Loads a JSONL file of raw USAspending spending_by_award records (as
// written by fetch.mjs) into pub.agencies, pub.fsc, pub.nsns and
// pub.contract_actions.
//
// IMPORTANT: USAspending's spending_by_award endpoint carries no unit-price
// field, so this loader NEVER writes to pub.price_points.
//
// Writes are batched (loadRecords): per batch of BATCH_SIZE records one transaction
// runs a handful of multi-row statements instead of ~5 statements and a
// transaction per record. A batch that fails is re-run row by row through
// loadRecord (the original single-record path), so a bad record behaves exactly
// as it always did.
//
// Stored raw is minimal (minimalRaw): only the keys something reads, '{}' when there are none.
// Records dated before the class's history floor (history-floor.mjs) are dropped by loadRecords unless they attach to a part (parse an NSN).
//
// CLI:
//   node load.mjs --file x.jsonl --psc 5331

import { readFile } from 'node:fs/promises';
import { tx, upsert, chunk, closePool } from '../../shared/db.mjs';
import { extractNiin, extractNsn } from '../../shared/nsn.mjs';
import { floorFor } from './history-floor.mjs';

// What a stored USAspending row keeps in pub.contract_actions.raw (owner decision 2026-11-15: no raw API record).
// Only keys that some reader of raw can see on a non-DIBBS row (audit of every reader: the 2026-11 storage-limits report):
//   nsn   the part the action is attached to (index contract_actions_raw_nsn_idx; every NSN page, class pages)
//   cage  read from raw by the NSN page, the class winners/states queries; USAspending records carry none,
//         so it is kept only if a record ever does (the readers would then see it exactly as before)
// Everything else the API returns is already in a real column (Award ID -> piid, amounts, names, dates, uid -> source_url).
// raw is NOT NULL, so a row with nothing to keep stores '{}'.
export const USASPENDING_RAW_KEYS = Object.freeze(['nsn', 'cage']);

/** The raw object stored for a record: only USASPENDING_RAW_KEYS, nsn from the description parse. */
export function minimalRaw(record, nsn) {
  const out = {};
  if (nsn) out.nsn = nsn;
  const cage = record?.cage;
  if (typeof cage === 'string' && cage.trim() !== '') out.cage = cage;
  return out;
}

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

    const raw = minimalRaw(record, nsn);

    const res = await client.query(
      `INSERT INTO pub.contract_actions
         (award_uid, piid, psc, naics, description, action_date, obligation,
          agency_id, recipient_name, recipient_uei, source_url, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (award_uid, action_date) DO UPDATE
         SET recipient_uei = EXCLUDED.recipient_uei
         WHERE pub.contract_actions.recipient_uei IS NULL AND EXCLUDED.recipient_uei IS NOT NULL
       RETURNING (xmax = 0) AS inserted`,
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
        field(record, 'Recipient UEI', 'recipient_uei'),
        `https://www.usaspending.gov/award/${awardUid}`,
        JSON.stringify(raw),
      ]
    );

    // A conflicting row that only gains its UEI is an update, not a new record.
    return { awardUid, nsn, inserted: res.rows[0]?.inserted === true };
  });
}

// ---------------------------------------------------------------------------
// Batched path
// ---------------------------------------------------------------------------

/** Records per transaction. Statements use unnest of arrays, so the parameter count is fixed (a dozen). */
export const BATCH_SIZE = 500;

/**
 * Pure per-record preparation: everything loadRecord derives from a record
 * before touching the database. Throws exactly where loadRecord would throw
 * for the same record (unusable record, missing generated_internal_id); the
 * caller then runs the batch row by row so the original error surfaces.
 */
export function prepareRecord(record, psc) {
  const agencyName =
    field(record, 'Awarding Sub Agency', 'awarding_sub_agency') ||
    field(record, 'Awarding Agency', 'awarding_agency') ||
    null;
  const description = field(record, 'Description', 'description') || '';
  let nsn = extractNsn(description);
  if (!nsn) {
    const niin = extractNiin(description);
    if (isValidFscCode(psc) && niin && /^\d{9}$/.test(niin)) {
      nsn = `${psc}${niin}`;
    }
  }
  const awardUid = record['generated_internal_id'];
  if (!awardUid) {
    throw new Error('loadRecord: record missing generated_internal_id');
  }
  const raw = minimalRaw(record, nsn);
  return {
    awardUid,
    nsn,
    nsnFsc: nsn ? nsn.slice(0, 4) : null,
    itemName: nsn ? itemNameFromDescription(description) : null,
    agencyName,
    piid: field(record, 'Award ID', 'award_id'),
    description: description || null,
    actionDate: parseDate(field(record, 'Start Date', 'start_date')),
    obligation: parseAmount(field(record, 'Award Amount', 'amount')),
    recipientName: field(record, 'Recipient Name', 'recipient'),
    recipientUei: field(record, 'Recipient UEI', 'recipient_uei'),
    sourceUrl: `https://www.usaspending.gov/award/${awardUid}`,
    raw: JSON.stringify(raw),
  };
}

/**
 * Collapses records that share (award_uid, action_date) the way the row-by-row
 * loop resolves them: the first one is inserted (or, if the row already exists,
 * nothing but the UEI can change), and each later one can only fill a still-null
 * UEI. The result is the first record with the first non-null UEI of the group.
 * Records with no action_date never conflict (NULLs are distinct in the unique
 * constraint) and are all kept. Order of first appearance is preserved.
 */
export function collapseActions(plans) {
  const out = [];
  const byKey = new Map();
  for (const p of plans) {
    if (p.actionDate === null) {
      out.push(p);
      continue;
    }
    const key = `${p.awardUid}\u0000${p.actionDate}`;
    const first = byKey.get(key);
    if (!first) {
      const copy = { ...p };
      byKey.set(key, copy);
      out.push(copy);
    } else if (first.recipientUei === null && p.recipientUei !== null) {
      first.recipientUei = p.recipientUei;
    }
  }
  return out;
}

async function resolveAgencies(client, names, known) {
  const need = [...new Set(names)].filter((n) => n && !known.has(n));
  const found = new Map();
  if (need.length === 0) return found;
  const sel = (arr) =>
    client.query(
      `SELECT agency_id, name FROM pub.agencies
       WHERE name = ANY($1::text[]) AND toptier_code IS NULL AND subtier_code IS NULL`,
      [arr]
    );
  let res = await sel(need);
  for (const r of res.rows) found.set(r.name, r.agency_id);
  const missing = need.filter((n) => !found.has(n)); // first-appearance order, so ids are handed out in file order
  if (missing.length) {
    await client.query(
      `INSERT INTO pub.agencies (toptier_code, subtier_code, name)
       SELECT NULL, NULL, t.name FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord) ORDER BY t.ord
       ON CONFLICT (toptier_code, subtier_code, name) DO NOTHING`,
      [missing]
    );
    res = await sel(missing);
    for (const r of res.rows) found.set(r.name, r.agency_id);
  }
  return found;
}

/** One transaction body for a batch of prepared records; returns counts only (safe to re-run). */
async function writeBatch(client, plans, psc, knownAgencies) {
  await ensureFsc(client, psc);

  const newAgencies = await resolveAgencies(client, plans.map((p) => p.agencyName), knownAgencies);
  const agencyId = (name) => (name ? (knownAgencies.get(name) ?? newAgencies.get(name)) : null);

  // pub.fsc rows for the NSN prefixes, then pub.nsns, in key order so concurrent lanes lock in one order.
  const nsnMap = new Map();
  for (const p of plans) {
    if (!p.nsn) continue;
    const cur = nsnMap.get(p.nsn) || { fsc: p.nsnFsc, itemName: null };
    if (p.itemName) cur.itemName = p.itemName; // the last record that names the item wins, as with sequential upserts
    nsnMap.set(p.nsn, cur);
  }
  if (nsnMap.size) {
    const fscCodes = [...new Set([...nsnMap.values()].map((v) => v.fsc))].sort();
    await client.query(
      `INSERT INTO pub.fsc (fsc, name, render_depth)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT (fsc) DO NOTHING`,
      [fscCodes, fscCodes.map(fscName), fscCodes.map((c) => (isValidFscCode(c) ? 'deep' : 'excluded'))]
    );
    const nsns = [...nsnMap.keys()].sort();
    await client.query(
      `INSERT INTO pub.nsns (nsn, fsc, item_name)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (nsn) DO UPDATE
         SET fsc = EXCLUDED.fsc, item_name = COALESCE(EXCLUDED.item_name, pub.nsns.item_name)
         WHERE pub.nsns.fsc IS DISTINCT FROM EXCLUDED.fsc
            OR pub.nsns.item_name IS DISTINCT FROM COALESCE(EXCLUDED.item_name, pub.nsns.item_name)`,
      [nsns, nsns.map((n) => nsnMap.get(n).fsc), nsns.map((n) => nsnMap.get(n).itemName)]
    );
  }

  const rows = collapseActions(plans);
  const res = await client.query(
    `INSERT INTO pub.contract_actions
       (award_uid, piid, psc, naics, description, action_date, obligation,
        agency_id, recipient_name, recipient_uei, source_url, raw)
     SELECT t.award_uid, t.piid, $1::text, NULL, t.description, t.action_date, t.obligation,
            t.agency_id, t.recipient_name, t.recipient_uei, t.source_url, t.raw
     FROM unnest($2::text[], $3::text[], $4::text[], $5::date[], $6::numeric[], $7::int[],
                 $8::text[], $9::text[], $10::text[], $11::jsonb[])
          WITH ORDINALITY AS t(award_uid, piid, description, action_date, obligation, agency_id,
                               recipient_name, recipient_uei, source_url, raw, ord)
     ORDER BY t.ord
     ON CONFLICT (award_uid, action_date) DO UPDATE
       SET recipient_uei = EXCLUDED.recipient_uei
       WHERE pub.contract_actions.recipient_uei IS NULL AND EXCLUDED.recipient_uei IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      psc,
      rows.map((p) => p.awardUid),
      rows.map((p) => p.piid),
      rows.map((p) => p.description),
      rows.map((p) => p.actionDate),
      rows.map((p) => p.obligation),
      rows.map((p) => agencyId(p.agencyName)),
      rows.map((p) => p.recipientName),
      rows.map((p) => p.recipientUei),
      rows.map((p) => p.sourceUrl),
      rows.map((p) => p.raw),
    ]
  );
  return {
    inserted: res.rows.filter((r) => r.inserted === true).length,
    newAgencies: [...newAgencies],
  };
}

/**
 * Loads records in batches. Same effect and same counts as calling loadRecord
 * for each record in order. A batch that cannot be prepared or written is re-run
 * row by row through loadRecord, which reports or throws exactly as before.
 *
 * Records dated before the class's history floor (history-floor.mjs; none for 5330 and 5331) are not
 * loaded unless they parse an NSN (part-attached records are always kept): `onDropped(n)` is told how many (the return value keeps its shape). A record with no date is never
 * dropped. `floor` overrides the class floor (null = keep everything), for tests.
 *
 * @returns {Promise<{ inserted: number, withNsn: number }>}  skipped = records.length - inserted - dropped
 */
export async function loadRecords(records, psc, { batchSize = BATCH_SIZE, agencies = new Map(), onFallback, onDropped, floor } = {}) {
  let inserted = 0;
  let withNsn = 0;
  const keepFrom = floor === undefined ? floorFor(psc) : floor;
  let dropped = 0;
  if (keepFrom) {
    const kept = records.filter((r) => {
      const d = parseDate(field(r ?? {}, 'Start Date', 'start_date'));
      if (!(d && d < keepFrom)) return true;
      // Owner decision 2026-11-15: a pre-floor record that attaches to a part (parses an NSN) is kept.
      try {
        return Boolean(prepareRecord(r, psc).nsn);
      } catch {
        return false;
      }
    });
    dropped = records.length - kept.length;
    records = kept;
    if (dropped && onDropped) onDropped(dropped);
  }
  for (const part of chunk(records, batchSize)) {
    let plans;
    try {
      plans = part.map((r) => prepareRecord(r, psc));
    } catch {
      plans = null;
    }
    let done = false;
    if (plans) {
      try {
        const out = await tx((client) => writeBatch(client, plans, psc, agencies), { label: 'usaspending batch' });
        inserted += out.inserted;
        for (const [name, id] of out.newAgencies) agencies.set(name, id);
        withNsn += plans.filter((p) => p.nsn).length;
        done = true;
      } catch (err) {
        if (onFallback) onFallback(err, part.length);
      }
    } else if (onFallback) {
      onFallback(new Error('record could not be prepared'), part.length);
    }
    if (done) continue;
    for (const record of part) {
      const result = await loadRecord(record, psc); // throws as before on a bad record
      if (result.inserted) inserted += 1;
      if (result.nsn) withNsn += 1;
    }
  }
  return { inserted, withNsn };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = await readFile(args.file, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let inserted = 0;
  let skipped = 0;
  let withNsn = 0;
  let dropped = 0;
  const agencies = new Map();
  const onFallback = (err, n) =>
    console.error(`load.mjs: batch of ${n} failed (${err.code || err.message}); retrying its records one at a time`);

  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    let droppedHere = 0;
    const out = await loadRecords(pending, args.psc, { agencies, onFallback, onDropped: (n) => { droppedHere = n; } });
    inserted += out.inserted;
    skipped += pending.length - droppedHere - out.inserted;
    dropped += droppedHere;
    withNsn += out.withNsn;
    pending = [];
  };

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      console.error(`load.mjs: skipping unparseable line: ${err.message}`);
      skipped += 1;
      continue;
    }
    pending.push(record);
    if (pending.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(
    `load.mjs: ${lines.length} record(s) read, ${inserted} inserted, ${skipped} skipped (dupes/errors), ${withNsn} with parsed NSN` +
      (floorFor(args.psc) ? `, ${dropped} dropped (unattached, dated before the ${floorFor(args.psc)} history floor)` : '')
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .then(() => closePool()) // lets the process exit now instead of after the pool's idle timeout
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
