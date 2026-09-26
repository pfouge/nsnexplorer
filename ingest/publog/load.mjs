#!/usr/bin/env node
// ingest/publog/load.mjs
// Streaming loaders for the real PUB LOG bulk exports (see fetch.mjs /
// last-run-diagnostics.txt for confirmed on-disk filenames and headers):
//
//   P_FLIS_NSN.CSV   "FSC","NIIN","INC","ITEM_NAME","SOS","END_ITEM_NAME","CANCELLED_NIIN"
//                    -> UPDATE pub.nsns.item_name
//   V_FLIS_PART.CSV  "NIIN","PART_NUMBER","CAGE_CODE","CAGE_STATUS","RNCC","RNVC","DAC",
//                    "RNAAC","RNFC","RNSC","RNJC","SADC","HCC","MSDS","MEDALS"
//                    -> INSERT pub.part_numbers
//   CHARACTERISTICS  filename/header not yet confirmed by DLA; discovered at
//                    runtime (see findCharacteristicsFile) -> UPDATE pub.nsns.characteristics
//   P_CAGE.CSV       "CAGE_CODE","CAGE_STATUS","TYPE","CAO","COMPANY","CITY",
//                    "STATE_PROVINCE","ZIP_POSTAL_ZONE","COUNTRY"
//                    -> upsert pub.suppliers
//
// DESIGN RULE (do not remove): PUB LOG is a bulk dump of the *entire*
// federal catalog (~80k+ NSNs). This project only ever builds static pages
// for the small set of NSNs we already track (Cloudflare Pages caps a
// deploy at 20k files). So this loader must only ENRICH rows that already
// exist in pub.nsns — it must NEVER INSERT a new pub.nsns row. Every
// filter below is keyed off a Map of already-tracked NIIN -> NSN built from
// the database before any file is read; NIINs not in that map are skipped.
//
// Files are 1GB+, so every one of them is streamed line-by-line with
// node:readline over fs.createReadStream — nothing here ever holds a full
// file in memory. The only things kept across the whole run are: the
// tracked NIIN->NSN map, the small set of CAGE codes referenced by inserted
// part numbers, and (for the characteristics file only) an aggregation Map
// bounded by the number of tracked NSNs.
//
// CLI:
//   node load.mjs --dir extracted/

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { tx, getPool, closePool } from '../../shared/db.mjs';

export const PUBLOG_SOURCE_URL =
  'https://www.dla.mil/Portals/104/Documents/InformationOperations/LogisticsInformationServices/FOIA/PUBLOG/';

const BATCH_SIZE = 2000;

const KNOWN_FILENAMES = ['P_FLIS_NSN.CSV', 'V_FLIS_PART.CSV', 'P_CAGE.CSV'];

// ---------------------------------------------------------------------------
// CSV line splitting
// ---------------------------------------------------------------------------

/**
 * Splits a single CSV line into fields. Handles quoted fields (possibly
 * containing commas) and doubled-quote escaping ("" -> "). PUB LOG exports
 * are simple quoted CSV with no embedded newlines, so line-at-a-time
 * splitting (rather than a full streaming CSV state machine) is safe here.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;
  const len = line.length;

  while (i < len) {
    const c = line[i];

    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"' && field === '' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }

    if (c === ',') {
      fields.push(field);
      field = '';
      fieldStarted = false;
      i += 1;
      continue;
    }

    field += c;
    fieldStarted = true;
    i += 1;
  }

  fields.push(field);
  return fields;
}

// ---------------------------------------------------------------------------
// Small header-index helpers
// ---------------------------------------------------------------------------

function findColumnIndex(headers, candidates) {
  const upper = headers.map((h) => h.trim().toUpperCase());
  for (const cand of candidates) {
    const idx = upper.indexOf(cand.trim().toUpperCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function requireColumnIndex(headers, candidates, fileLabel) {
  const idx = findColumnIndex(headers, candidates);
  if (idx === -1) {
    throw new Error(
      `load.mjs: ${fileLabel}: none of [${candidates.join(', ')}] found in headers. ` +
        `Headers present: [${headers.join(', ')}]`
    );
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Streaming line source
// ---------------------------------------------------------------------------

async function* csvLines(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line === '') continue; // blank/trailing lines
    yield splitCsvLine(line);
  }
}

async function readFirstLine(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      return line;
    }
    return '';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Pure row-mapping helpers (no DB access — unit testable)
// ---------------------------------------------------------------------------

const NIIN_RE = /^\d{9}$/;
const CAGE_RE = /^[A-Z0-9]{5}$/;

/**
 * Normalizes a raw CAGE string: uppercase, must match [A-Z0-9]{5} or the
 * result is null.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeCage(raw) {
  const cage = (raw || '').trim().toUpperCase();
  return CAGE_RE.test(cage) ? cage : null;
}

/**
 * Maps one P_FLIS_NSN.CSV row to a pub.nsns item_name update, or null if the
 * row should be skipped. Only rows whose FSC+NIIN form an *already tracked*
 * NSN are ever considered (see the design rule at the top of this file) —
 * this never causes a new pub.nsns row to be created.
 *
 * @param {{fsc: string, niin: string, itemName: string}} row
 * @param {Map<string,string>} trackedByNiin - niin(9) -> nsn(13) of tracked pub.nsns rows
 * @returns {{nsn: string, itemName: string}|null}
 */
export function mapIdentificationRow(row, trackedByNiin) {
  const niin = (row.niin || '').trim();
  if (!NIIN_RE.test(niin)) return null;

  const trackedNsn = trackedByNiin.get(niin);
  if (!trackedNsn) return null;

  const fsc = (row.fsc || '').trim();
  const nsn = `${fsc}${niin}`;
  if (nsn !== trackedNsn) return null; // FSC in this row doesn't match the tracked NSN

  const itemName = (row.itemName || '').trim();
  if (!itemName || itemName === 'NO ITEM NAME AVAILABLE') return null;

  return { nsn, itemName };
}

/**
 * Maps one V_FLIS_PART.CSV row to a pub.part_numbers insert, or null if the
 * NIIN isn't tracked or there's no part number. CAGE is normalized and set
 * to null when malformed, never dropping the row.
 *
 * @param {{niin: string, partNumber: string, cage: string}} row
 * @param {Map<string,string>} trackedByNiin
 * @returns {{nsn: string, partNumber: string, cage: string|null}|null}
 */
export function mapPartRow(row, trackedByNiin) {
  const niin = (row.niin || '').trim();
  if (!NIIN_RE.test(niin)) return null;

  const nsn = trackedByNiin.get(niin);
  if (!nsn) return null;

  const partNumber = (row.partNumber || '').trim();
  if (!partNumber) return null;

  const cage = normalizeCage(row.cage);

  return { nsn, partNumber, cage };
}

/**
 * Maps one P_CAGE.CSV row to a pub.suppliers upsert, or null if the CAGE is
 * malformed or wasn't referenced by any inserted part number.
 *
 * @param {{cage: string, company: string, city: string, state: string, country: string}} row
 * @param {Set<string>} referencedCages
 * @returns {{cage: string, name: string|null, city: string|null, state: string|null, country: string|null}|null}
 */
export function mapCageRow(row, referencedCages) {
  const cage = normalizeCage(row.cage);
  if (!cage || !referencedCages.has(cage)) return null;

  return {
    cage,
    name: (row.company || '').trim() || null,
    city: (row.city || '').trim() || null,
    state: (row.state || '').trim() || null,
    country: (row.country || '').trim() || null,
  };
}

/**
 * Maps one characteristics-file row to a {nsn, entry} pair, or null. `entry`
 * is the {mrc, requirement, reply} object that gets aggregated per NSN.
 *
 * @param {{niin: string, mrc: string, requirement: string, reply: string}} row
 * @param {Map<string,string>} trackedByNiin
 * @returns {{nsn: string, entry: {mrc: string, requirement: string, reply: string}}|null}
 */
export function mapCharacteristicsRow(row, trackedByNiin) {
  const niin = (row.niin || '').trim();
  if (!NIIN_RE.test(niin)) return null;

  const nsn = trackedByNiin.get(niin);
  if (!nsn) return null;

  const mrc = (row.mrc || '').trim();
  if (!mrc) return null;

  return {
    nsn,
    entry: {
      mrc,
      requirement: (row.requirement || '').trim(),
      reply: (row.reply || '').trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// DB: tracked-NIIN map
// ---------------------------------------------------------------------------

/**
 * Builds the Map(niin -> nsn) of already-tracked pub.nsns rows. This is the
 * gate that keeps PUB LOG from inserting new catalog rows — see the design
 * rule comment at the top of this file.
 *
 * @returns {Promise<Map<string,string>>}
 */
export async function buildTrackedNiinMap() {
  const pool = getPool();
  const res = await pool.query('SELECT nsn, niin FROM pub.nsns');
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.niin, row.nsn);
  }
  return map;
}

// ---------------------------------------------------------------------------
// DB: batch flush helpers (each runs in its own modest transaction)
// ---------------------------------------------------------------------------

async function flushIdentificationBatch(batch) {
  if (batch.length === 0) return 0;
  await tx(async (client) => {
    await client.query(
      `UPDATE pub.nsns AS n
       SET item_name = v.item_name, updated_at = now()
       FROM (
         SELECT * FROM unnest($1::text[], $2::text[]) AS t(nsn, item_name)
       ) AS v
       WHERE n.nsn = v.nsn`,
      [batch.map((r) => r.nsn), batch.map((r) => r.itemName)]
    );
  });
  return batch.length;
}

async function flushPartsBatch(batch) {
  if (batch.length === 0) return 0;
  await tx(async (client) => {
    await client.query(
      `INSERT INTO pub.part_numbers (nsn, part_number, cage, source, source_url)
       SELECT nsn, part_number, cage, 'flis', $4
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(nsn, part_number, cage)
       ON CONFLICT (nsn, part_number, cage) DO NOTHING`,
      [
        batch.map((r) => r.nsn),
        batch.map((r) => r.partNumber),
        batch.map((r) => r.cage),
        PUBLOG_SOURCE_URL,
      ]
    );
  });
  return batch.length;
}

async function flushCageBatch(batch) {
  if (batch.length === 0) return 0;
  await tx(async (client) => {
    await client.query(
      `INSERT INTO pub.suppliers (cage, name, city, state, country, updated_at)
       SELECT cage, name, city, state, country, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
         AS t(cage, name, city, state, country)
       ON CONFLICT (cage) DO UPDATE SET
         name = EXCLUDED.name,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         country = EXCLUDED.country,
         updated_at = now()`,
      [
        batch.map((r) => r.cage),
        batch.map((r) => r.name),
        batch.map((r) => r.city),
        batch.map((r) => r.state),
        batch.map((r) => r.country),
      ]
    );
  });
  return batch.length;
}

async function flushCharacteristics(aggregated) {
  const entries = [...aggregated.entries()];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const chunk = entries.slice(i, i + BATCH_SIZE);
    await tx(async (client) => {
      await client.query(
        `UPDATE pub.nsns AS n
         SET characteristics = v.characteristics::jsonb, updated_at = now()
         FROM (
           SELECT * FROM unnest($1::text[], $2::text[]) AS t(nsn, characteristics)
         ) AS v
         WHERE n.nsn = v.nsn`,
        [chunk.map(([nsn]) => nsn), chunk.map(([, rows]) => JSON.stringify(rows))]
      );
    });
  }
  return entries.length;
}

// ---------------------------------------------------------------------------
// File loaders (streaming; pure mapping above, DB writes batched here)
// ---------------------------------------------------------------------------

/**
 * Streams P_FLIS_NSN.CSV, updating pub.nsns.item_name for tracked NSNs.
 *
 * @param {string} filePath
 * @param {Map<string,string>} trackedByNiin
 * @returns {Promise<{loaded: number, scanned: number}>}
 */
export async function loadIdentificationFile(filePath, trackedByNiin) {
  let scanned = 0;
  let loaded = 0;
  let cols = null;
  let batch = [];

  for await (const fields of csvLines(filePath)) {
    if (!cols) {
      cols = {
        fsc: requireColumnIndex(fields, ['FSC'], 'P_FLIS_NSN.CSV'),
        niin: requireColumnIndex(fields, ['NIIN'], 'P_FLIS_NSN.CSV'),
        itemName: findColumnIndex(fields, ['ITEM_NAME']),
      };
      continue;
    }
    scanned += 1;
    const row = {
      fsc: fields[cols.fsc],
      niin: fields[cols.niin],
      itemName: cols.itemName !== -1 ? fields[cols.itemName] : '',
    };
    const mapped = mapIdentificationRow(row, trackedByNiin);
    if (mapped) {
      batch.push(mapped);
      if (batch.length >= BATCH_SIZE) {
        loaded += await flushIdentificationBatch(batch);
        batch = [];
      }
    }
  }
  loaded += await flushIdentificationBatch(batch);

  return { loaded, scanned };
}

/**
 * Streams V_FLIS_PART.CSV, inserting pub.part_numbers rows for tracked
 * NIINs. Returns the set of valid CAGE codes seen on rows that were loaded,
 * so the CAGE step only has to consider suppliers we actually reference.
 *
 * @param {string} filePath
 * @param {Map<string,string>} trackedByNiin
 * @returns {Promise<{loaded: number, scanned: number, referencedCages: Set<string>}>}
 */
export async function loadPartsFile(filePath, trackedByNiin) {
  let scanned = 0;
  let loaded = 0;
  let cols = null;
  let batch = [];
  const referencedCages = new Set();

  for await (const fields of csvLines(filePath)) {
    if (!cols) {
      cols = {
        niin: requireColumnIndex(fields, ['NIIN'], 'V_FLIS_PART.CSV'),
        partNumber: requireColumnIndex(fields, ['PART_NUMBER'], 'V_FLIS_PART.CSV'),
        cage: findColumnIndex(fields, ['CAGE_CODE']),
      };
      continue;
    }
    scanned += 1;
    const row = {
      niin: fields[cols.niin],
      partNumber: fields[cols.partNumber],
      cage: cols.cage !== -1 ? fields[cols.cage] : '',
    };
    const mapped = mapPartRow(row, trackedByNiin);
    if (mapped) {
      if (mapped.cage) referencedCages.add(mapped.cage);
      batch.push(mapped);
      if (batch.length >= BATCH_SIZE) {
        loaded += await flushPartsBatch(batch);
        batch = [];
      }
    }
  }
  loaded += await flushPartsBatch(batch);

  return { loaded, scanned, referencedCages };
}

/**
 * Streams P_CAGE.CSV, upserting pub.suppliers for CAGE codes referenced by
 * loaded part numbers. Existing uei/sam_url values are left untouched.
 *
 * @param {string} filePath
 * @param {Set<string>} referencedCages
 * @returns {Promise<{loaded: number, scanned: number}>}
 */
export async function loadCageFile(filePath, referencedCages) {
  let scanned = 0;
  let loaded = 0;
  let cols = null;
  let batch = [];

  for await (const fields of csvLines(filePath)) {
    if (!cols) {
      cols = {
        cage: requireColumnIndex(fields, ['CAGE_CODE'], 'P_CAGE.CSV'),
        company: findColumnIndex(fields, ['COMPANY']),
        city: findColumnIndex(fields, ['CITY']),
        state: findColumnIndex(fields, ['STATE_PROVINCE']),
        country: findColumnIndex(fields, ['COUNTRY']),
      };
      continue;
    }
    scanned += 1;
    const row = {
      cage: fields[cols.cage],
      company: cols.company !== -1 ? fields[cols.company] : '',
      city: cols.city !== -1 ? fields[cols.city] : '',
      state: cols.state !== -1 ? fields[cols.state] : '',
      country: cols.country !== -1 ? fields[cols.country] : '',
    };
    const mapped = mapCageRow(row, referencedCages);
    if (mapped) {
      batch.push(mapped);
      if (batch.length >= BATCH_SIZE) {
        loaded += await flushCageBatch(batch);
        batch = [];
      }
    }
  }
  loaded += await flushCageBatch(batch);

  return { loaded, scanned };
}

/**
 * Finds the characteristics CSV among the extracted files: any *.CSV other
 * than the three known filenames whose header contains a NIIN-like column
 * and an MRC-like column. The real filename/header aren't confirmed yet, so
 * this is best-effort discovery rather than a fixed filename lookup.
 *
 * @param {string} dir
 * @param {string[]} [excludeFilenames]
 * @returns {Promise<{filePath: string, filename: string, headers: string[]}|null>}
 */
export async function findCharacteristicsFile(dir, excludeFilenames = KNOWN_FILENAMES) {
  const entries = await readdir(dir);
  const excluded = new Set(excludeFilenames.map((f) => f.toUpperCase()));
  const candidates = entries.filter(
    (f) => f.toUpperCase().endsWith('.CSV') && !excluded.has(f.toUpperCase())
  );

  for (const filename of candidates) {
    const filePath = path.join(dir, filename);
    const headerLine = await readFirstLine(filePath);
    if (!headerLine) continue;
    const headers = splitCsvLine(headerLine).map((h) => h.trim());
    const upper = headers.map((h) => h.toUpperCase());
    const hasNiin = upper.includes('NIIN');
    const hasMrc = upper.includes('MRC') || upper.some((h) => h.includes('MRC'));
    if (hasNiin && hasMrc) {
      return { filePath, filename, headers };
    }
    console.log(
      `load.mjs: characteristics candidate ${filename} rejected (headers: ${headers.join(', ')})`
    );
  }
  return null;
}

/**
 * Streams a characteristics CSV (see findCharacteristicsFile), aggregating
 * {mrc, requirement, reply} rows per tracked NSN and writing them to
 * pub.nsns.characteristics as a JSON array once the file has been fully
 * read. If the requirement/reply columns can't be found, logs the headers
 * that were found and continues, loading mrc-only entries.
 *
 * @param {string} filePath
 * @param {Map<string,string>} trackedByNiin
 * @returns {Promise<{loaded: number, scanned: number}>}
 */
export async function loadCharacteristicsFile(filePath, trackedByNiin) {
  let scanned = 0;
  let cols = null;
  const aggregated = new Map(); // nsn -> [{mrc, requirement, reply}, ...]

  for await (const fields of csvLines(filePath)) {
    if (!cols) {
      const niinIdx = findColumnIndex(fields, ['NIIN']);
      let mrcIdx = findColumnIndex(fields, ['MRC']);
      if (mrcIdx === -1) {
        mrcIdx = fields.findIndex((h) => h.trim().toUpperCase().includes('MRC'));
      }
      if (niinIdx === -1 || mrcIdx === -1) {
        console.log(
          `load.mjs: characteristics file has no usable NIIN/MRC columns; ` +
            `headers found: [${fields.join(', ')}]. Skipping characteristics load.`
        );
        return { loaded: 0, scanned: 0 };
      }
      const reqIdx = findColumnIndex(fields, [
        'REQUIREMENTS_STATEMENT',
        'REQUIREMENT_STATEMENT',
        'MRC_NAME',
        'REQUIREMENTS',
      ]);
      const replyIdx = findColumnIndex(fields, [
        'CLEAR_TEXT_REPLY',
        'REPLY',
        'CHARACTERISTIC_VALUE',
        'MRC_REPLY',
      ]);
      if (reqIdx === -1 || replyIdx === -1) {
        console.log(
          `load.mjs: characteristics file is missing requirement/reply columns; ` +
            `headers found: [${fields.join(', ')}]. Continuing with mrc-only entries.`
        );
      }
      cols = { niinIdx, mrcIdx, reqIdx, replyIdx };
      continue;
    }
    scanned += 1;
    const row = {
      niin: fields[cols.niinIdx],
      mrc: fields[cols.mrcIdx],
      requirement: cols.reqIdx !== -1 ? fields[cols.reqIdx] : '',
      reply: cols.replyIdx !== -1 ? fields[cols.replyIdx] : '',
    };
    const mapped = mapCharacteristicsRow(row, trackedByNiin);
    if (mapped) {
      if (!aggregated.has(mapped.nsn)) aggregated.set(mapped.nsn, []);
      aggregated.get(mapped.nsn).push(mapped.entry);
    }
  }

  const loaded = await flushCharacteristics(aggregated);
  return { loaded, scanned };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
  }
  if (!args.dir) throw new Error('load.mjs: --dir is required');
  return args;
}

function findFile(filesOnDisk, filename) {
  return filesOnDisk.find((f) => f.toUpperCase() === filename.toUpperCase()) || null;
}

function report(filename, result) {
  console.log(`load.mjs: ${filename}: ${result.loaded} loaded, ${result.scanned} rows scanned`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filesOnDisk = await readdir(args.dir);

  const trackedByNiin = await buildTrackedNiinMap();
  console.log(`load.mjs: tracking ${trackedByNiin.size} existing NIIN(s)`);

  // identification -> parts (+ collect cages) -> characteristics -> cage
  const identificationFile = findFile(filesOnDisk, 'P_FLIS_NSN.CSV');
  if (identificationFile) {
    const result = await loadIdentificationFile(
      path.join(args.dir, identificationFile),
      trackedByNiin
    );
    report('P_FLIS_NSN.CSV', result);
  } else {
    console.log(`load.mjs: P_FLIS_NSN.CSV not found in ${args.dir}, skipping`);
  }

  let referencedCages = new Set();
  const partsFile = findFile(filesOnDisk, 'V_FLIS_PART.CSV');
  if (partsFile) {
    const result = await loadPartsFile(path.join(args.dir, partsFile), trackedByNiin);
    referencedCages = result.referencedCages;
    report('V_FLIS_PART.CSV', result);
  } else {
    console.log(`load.mjs: V_FLIS_PART.CSV not found in ${args.dir}, skipping`);
  }

  const characteristicsFile = await findCharacteristicsFile(args.dir);
  if (characteristicsFile) {
    const result = await loadCharacteristicsFile(characteristicsFile.filePath, trackedByNiin);
    report(characteristicsFile.filename, result);
  } else {
    console.log(`load.mjs: no characteristics CSV found in ${args.dir}, skipping`);
  }

  const cageFile = findFile(filesOnDisk, 'P_CAGE.CSV');
  if (cageFile) {
    const result = await loadCageFile(path.join(args.dir, cageFile), referencedCages);
    report('P_CAGE.CSV', result);
  } else {
    console.log(`load.mjs: P_CAGE.CSV not found in ${args.dir}, skipping`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
