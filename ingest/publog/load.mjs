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
//   V_MOE_RULE.CSV   (from MOE_RULE.zip) one row per NIIN per managing service. DLA documents
//                    the layout by position only (1 NIIN, 2 MOE rule no., 3 MOE code, 4 AMC,
//                    5 AMSC, 6 NIMSC, 7 date assigned, ..., last ROW_OBS_DT); the literal
//                    header names are unconfirmed, so columns are resolved by name first and
//                    by position second (see resolveMoeColumns)
//                    -> INSERT pub.amsc_observations (source='flis')
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

const MOE_RULE_FILENAME = 'V_MOE_RULE.CSV';

const KNOWN_FILENAMES = ['P_FLIS_NSN.CSV', 'V_FLIS_PART.CSV', 'P_CAGE.CSV', MOE_RULE_FILENAME];

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
// MOE rule (AMC / AMSC) -> pub.amsc_observations
// ---------------------------------------------------------------------------

const MON = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function isoDate(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Parses a ROW_OBS_DT-style value to 'YYYY-MM-DD', or null when it is not a
 * recognisable calendar date. The real format is unconfirmed (11 characters
 * per DLA's layout, which fits DD-MON-YYYY), so several shapes are accepted:
 * DD-MON-YYYY, YYYY-MM-DD (optionally followed by a time), YYYYMMDD and
 * MM/DD/YYYY. Dates after `maxDate` (when given) are treated as unparseable
 * so a junk future date can never shadow later observations.
 *
 * @param {string} raw
 * @param {string} [maxDate] 'YYYY-MM-DD'
 * @returns {string|null}
 */
export function parseObsDate(raw, maxDate) {
  const t = (raw || '').trim();
  if (!t) return null;
  let out = null;
  let m;
  if ((m = /^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})(?:\D.*)?$/.exec(t))) {
    const mon = MON[m[2].toUpperCase()];
    out = mon ? isoDate(Number(m[3]), mon, Number(m[1])) : null;
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:\D.*)?$/.exec(t))) {
    out = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  } else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) {
    out = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D.*)?$/.exec(t))) {
    out = isoDate(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  if (out && maxDate && out > maxDate) return null;
  return out;
}

/** AMC must be a single character 0-5; anything else is blank (null). */
export function normalizeAmc(raw) {
  const t = (raw || '').trim();
  return /^[0-5]$/.test(t) ? t : null;
}

/** AMSC must be a single letter or digit (uppercased); anything else is blank (null). */
export function normalizeAmsc(raw) {
  const t = (raw || '').trim();
  return /^[A-Za-z0-9]$/.test(t) ? t.toUpperCase() : null;
}

/**
 * Resolves the V_MOE_RULE.CSV columns we need from the header row. Name match
 * first (case-insensitive, exact): NIIN; MOE_CD / MOE_CODE / MOE; AMC; AMSC;
 * any header containing ROW_OBS. When a name is not found, falls back to DLA's
 * documented positions: NIIN col 1, MOE code col 3, AMC col 4, AMSC col 5
 * (0-based 0, 2, 3, 4) and the last column for ROW_OBS_DT. `via` records which
 * strategy produced each index so the run can log it.
 *
 * @param {string[]} headers
 * @returns {{niin: number, moe: number, amc: number, amsc: number, obs: number,
 *            via: Record<string, 'header'|'position'>}}
 */
export function resolveMoeColumns(headers) {
  const via = {};
  const byName = (key, candidates, fallback) => {
    const idx = findColumnIndex(headers, candidates);
    via[key] = idx !== -1 ? 'header' : 'position';
    return idx !== -1 ? idx : fallback;
  };
  const niin = byName('niin', ['NIIN'], 0);
  const moe = byName('moe', ['MOE_CD', 'MOE_CODE', 'MOE'], 2);
  const amc = byName('amc', ['AMC'], 3);
  const amsc = byName('amsc', ['AMSC'], 4);
  const obsIdx = headers.findIndex((h) => h.trim().toUpperCase().includes('ROW_OBS'));
  via.obs = obsIdx !== -1 ? 'header' : 'position';
  const obs = obsIdx !== -1 ? obsIdx : Math.max(headers.length - 1, 0);
  return { niin, moe, amc, amsc, obs, via };
}

/**
 * Maps one V_MOE_RULE.CSV row to a candidate observation, or null when the
 * NIIN is not tracked or both AMC and AMSC are blank/invalid after
 * normalisation. Never creates NSNs (enrich-only, see the top of this file).
 *
 * @param {{niin: string, moe: string, amc: string, amsc: string, obs: string}} row
 * @param {Map<string,string>} trackedByNiin
 * @param {{today?: string}} [opts]
 * @returns {{nsn: string, moe: string, amc: string|null, amsc: string|null,
 *            date: string|null, amcRejected: boolean, amscRejected: boolean}|null}
 */
export function mapMoeRuleRow(row, trackedByNiin, opts = {}) {
  const niin = (row.niin || '').trim();
  if (!NIIN_RE.test(niin)) return null;
  const nsn = trackedByNiin.get(niin);
  if (!nsn) return null;

  const amc = normalizeAmc(row.amc);
  const amsc = normalizeAmsc(row.amsc);
  if (amc === null && amsc === null) return null;

  return {
    nsn,
    moe: (row.moe || '').trim().toUpperCase(),
    amc,
    amsc,
    date: parseObsDate(row.obs, opts.today),
    amcRejected: amc === null && (row.amc || '').trim() !== '',
    amscRejected: amsc === null && (row.amsc || '').trim() !== '',
  };
}

/**
 * True when `cand` should replace `cur` as the one kept row for an NSN:
 * a DS (DLA) rule beats any other; within the same rank the later ROW_OBS_DT
 * wins; a row with a parseable date beats one without; with no dates on
 * either side the last row seen wins.
 */
export function isBetterMoeRow(cur, cand) {
  if (!cur) return true;
  const cr = cur.moe === 'DS' ? 1 : 0;
  const nr = cand.moe === 'DS' ? 1 : 0;
  if (nr !== cr) return nr > cr;
  if (cur.date && cand.date) return cand.date >= cur.date;
  if (cur.date || cand.date) return Boolean(cand.date);
  return true;
}

/**
 * Cheap pre-filter for the 17M-row file: when the NIIN is the first field and
 * the line has the expected 9-char shape, returns whether it is tracked
 * without splitting the whole line. Returns null if the shape is unexpected
 * (caller then falls back to the full parse), so this can never wrongly drop
 * a row.
 */
function quickNiinTracked(line, trackedByNiin) {
  if (line.charCodeAt(0) === 34) {
    if (line.charCodeAt(10) !== 34) return null;
    return trackedByNiin.has(line.slice(1, 10));
  }
  if (line.charCodeAt(9) !== 44) return null;
  return trackedByNiin.has(line.slice(0, 9));
}

/**
 * Streams V_MOE_RULE.CSV and keeps ONE best row per tracked NSN (see
 * isBetterMoeRow). Memory is bounded by the number of tracked NSNs. No DB
 * access here. Logs the header line and the resolved column mapping.
 *
 * @param {string} filePath
 * @param {Map<string,string>} trackedByNiin
 * @param {{log?: (msg: string) => void, today?: string}} [opts]
 */
export async function collectMoeRule(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const best = new Map(); // nsn -> mapped row
  const stats = {
    scanned: 0, matched: 0, kept: 0, blankSkipped: 0,
    amcRejected: 0, amscRejected: 0, undatedKept: 0,
  };
  let cols = null;
  let columnsLog = null;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const handleFields = (fields) => {
    stats.scanned += 1;
    const mapped = mapMoeRuleRow(
      {
        niin: fields[cols.niin],
        moe: fields[cols.moe],
        amc: fields[cols.amc],
        amsc: fields[cols.amsc],
        obs: fields[cols.obs],
      },
      trackedByNiin,
      { today }
    );
    if (!mapped) {
      // Distinguish "tracked NIIN but both codes blank" for the log.
      const niin = (fields[cols.niin] || '').trim();
      if (trackedByNiin.has(niin)) {
        stats.matched += 1;
        stats.blankSkipped += 1;
      }
      return;
    }
    stats.matched += 1;
    if (mapped.amcRejected) stats.amcRejected += 1;
    if (mapped.amscRejected) stats.amscRejected += 1;
    if (isBetterMoeRow(best.get(mapped.nsn), mapped)) best.set(mapped.nsn, mapped);
  };

  try {
    for await (const line of rl) {
      if (line === '') continue;
      if (!cols) {
        const fields = splitCsvLine(line);
        const looksLikeData = NIIN_RE.test((fields[0] || '').trim());
        log(`load.mjs: ${MOE_RULE_FILENAME} first line: ${line.slice(0, 500)}`);
        if (looksLikeData) {
          cols = resolveMoeColumns([]);
          cols.obs = Math.max(fields.length - 1, 0);
          log(`load.mjs: ${MOE_RULE_FILENAME} has no header row (first field is a NIIN); using positional columns`);
        } else {
          cols = resolveMoeColumns(fields);
        }
        columnsLog =
          `niin=${cols.niin}(${cols.via.niin}) moe=${cols.moe}(${cols.via.moe}) ` +
          `amc=${cols.amc}(${cols.via.amc}) amsc=${cols.amsc}(${cols.via.amsc}) ` +
          `obs=${cols.obs}(${cols.via.obs}) of ${fields.length} column(s)` +
          (looksLikeData ? '' : ` [headers: ${fields.join(', ')}]`);
        log(`load.mjs: ${MOE_RULE_FILENAME} resolved columns (0-based): ${columnsLog}`);
        if (looksLikeData) handleFields(fields);
        continue;
      }
      if (cols.niin === 0) {
        const tracked = quickNiinTracked(line, trackedByNiin);
        if (tracked === false) {
          stats.scanned += 1;
          continue;
        }
      }
      handleFields(splitCsvLine(line));
    }
  } finally {
    rl.close();
  }

  stats.kept = best.size;
  for (const r of best.values()) if (!r.date) stats.undatedKept += 1;
  return { best, stats, columns: columnsLog };
}

function distribution(values) {
  const d = {};
  for (const v of values) d[v ?? '-'] = (d[v ?? '-'] || 0) + 1;
  return Object.entries(d).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(' ');
}

/**
 * Writes the kept observations to pub.amsc_observations in batches. An NSN
 * whose latest existing 'flis' observation already has the same amc/amsc is
 * skipped (no new dated row for an unchanged value). Idempotent via
 * ON CONFLICT on the table's UNIQUE (nsn, observed_on, source, source_ref).
 *
 * @param {Map<string, {nsn: string, amc: string|null, amsc: string|null, date: string|null}>} best
 * @param {string} today 'YYYY-MM-DD'
 * @returns {Promise<{written: number, unchanged: number}>}
 */
async function flushMoeObservations(best, today) {
  const rows = [...best.values()];
  let written = 0;
  let unchanged = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await tx(async (client) => {
      const latest = await client.query(
        `SELECT DISTINCT ON (nsn) nsn, amc, amsc
         FROM pub.amsc_observations
         WHERE source = 'flis' AND nsn = ANY($1::text[])
         ORDER BY nsn, observed_on DESC, id DESC`,
        [chunk.map((r) => r.nsn)]
      );
      const cur = new Map(latest.rows.map((r) => [r.nsn, r]));
      const todo = chunk.filter((r) => {
        const c = cur.get(r.nsn);
        return !(c && (c.amc ?? null) === r.amc && (c.amsc ?? null) === r.amsc);
      });
      if (todo.length > 0) {
        await client.query(
          `INSERT INTO pub.amsc_observations (nsn, amc, amsc, observed_on, source, source_ref, source_url)
           SELECT nsn, amc, amsc, observed_on::date, 'flis', $5, $6
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
             AS t(nsn, amc, amsc, observed_on)
           ON CONFLICT (nsn, observed_on, source, source_ref) DO UPDATE SET
             amc = EXCLUDED.amc,
             amsc = EXCLUDED.amsc,
             source_url = EXCLUDED.source_url`,
          [
            todo.map((r) => r.nsn),
            todo.map((r) => r.amc),
            todo.map((r) => r.amsc),
            todo.map((r) => r.date || today),
            MOE_RULE_FILENAME,
            PUBLOG_SOURCE_URL,
          ]
        );
      }
      return { written: todo.length, unchanged: chunk.length - todo.length };
    });
    written += res.written;
    unchanged += res.unchanged;
  }
  return { written, unchanged };
}

/**
 * Streams V_MOE_RULE.CSV and records AMC/AMSC for tracked NSNs in
 * pub.amsc_observations (source='flis'). Enrich-only: never inserts pub.nsns.
 *
 * @param {string} filePath
 * @param {Map<string,string>} trackedByNiin
 * @param {{log?: (msg: string) => void, today?: string}} [opts]
 * @returns {Promise<{loaded: number, scanned: number, matched: number, kept: number, unchanged: number}>}
 */
export async function loadMoeRule(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const { best, stats } = await collectMoeRule(filePath, trackedByNiin, { ...opts, log, today });
  log(
    `load.mjs: ${MOE_RULE_FILENAME}: ${stats.scanned} rows scanned, ${stats.matched} on tracked NIINs, ` +
      `${stats.blankSkipped} skipped (AMC and AMSC both blank), ${stats.amcRejected} invalid AMC and ` +
      `${stats.amscRejected} invalid AMSC treated as blank, ${stats.kept} NSN(s) with a kept row ` +
      `(${stats.undatedKept} without a parseable date)`
  );
  log(
    `load.mjs: ${MOE_RULE_FILENAME} kept AMC distribution: ${distribution([...best.values()].map((r) => r.amc))}`
  );
  log(
    `load.mjs: ${MOE_RULE_FILENAME} kept AMSC distribution: ${distribution([...best.values()].map((r) => r.amsc))}`
  );
  if (stats.scanned > 0 && stats.matched > 0 && stats.kept === 0) {
    log(`load.mjs: WARNING ${MOE_RULE_FILENAME}: tracked NIINs matched but no usable AMC/AMSC; check the resolved columns above`);
  }
  const { written, unchanged } = await flushMoeObservations(best, today);
  log(`load.mjs: ${MOE_RULE_FILENAME}: ${written} observation(s) written, ${unchanged} unchanged (latest flis value identical)`);
  return { loaded: written, scanned: stats.scanned, matched: stats.matched, kept: stats.kept, unchanged };
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

  // AMC/AMSC ("Can you win it?"). Optional enrichment from an unconfirmed
  // layout: a missing file is skipped, and a failure is logged loudly but does
  // not fail the run (it would otherwise block the chained deploy).
  const moeFile = findFile(filesOnDisk, MOE_RULE_FILENAME);
  if (moeFile) {
    try {
      const result = await loadMoeRule(path.join(args.dir, moeFile), trackedByNiin);
      report(MOE_RULE_FILENAME, result);
    } catch (err) {
      console.error(err);
      console.log(`::warning::load.mjs: ${MOE_RULE_FILENAME} load failed (${err.message}); continuing`);
    }
  } else {
    console.log(`load.mjs: ${MOE_RULE_FILENAME} not found in ${args.dir} (MOE_RULE.zip missing?), skipping AMC/AMSC load`);
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
