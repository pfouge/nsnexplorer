// ingest/publog/load-flis.mjs
// Loaders for six PUB LOG files the job already downloads (migration 0014):
//
//   V_FLIS_IDENTIFICATION.CSV  -> pub.nsn_identification   (1 row per tracked NSN)
//   V_FLIS_STANDARDIZATION.CSV -> pub.nsn_standardization
//   V_FLIS_CANCELLED_NIIN.CSV  -> pub.nsn_cancellations    (tracked NIIN on either side)
//   V_MOE_RULE.CSV             -> pub.moe_rules            (every row of a tracked NIIN; shares the
//                                 single pass loadMoeRule already makes, see createMoeRulesAllLoader)
//   P_HELP.CSV                 -> pub.flis_codes           (whole file)
//   V_COLLOQUIAL_NAME.CSV      -> pub.inc_colloquial_names (whole file)
//
// Same rules as load.mjs: enrich-only (rows for NIINs not in pub.nsns are skipped), files are
// streamed line by line, columns are resolved by header name first and by documented position
// second (a file without a header row is read positionally), writes are batched single-statement
// upserts. Upserts only: a row that disappears from the source is LEFT IN PLACE (no deletes),
// so an NSN keeps its last known values. A row identical to the stored one is not rewritten, so
// a second run reports written = 0.
//
// Every loader returns {scanned, kept, written}; main() in load.mjs wraps each call so a failure
// logs a ::warning:: and the run continues.

import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  splitCsvLine, findColumnIndex, quickNiinTracked, NIIN_RE,
} from './load.mjs';
import { getPool, withRetry } from '../../shared/db.mjs';

const BATCH = 1000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MON = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Parses DD-MON-YY or DD-MON-YYYY (what PUB LOG publishes) to 'YYYY-MM-DD'; null when blank or
 * not a real calendar date. Two-digit years: 00..(current yy + 1) are 20yy, the rest 19yy
 * (NIINs were assigned from the 1950s on; nothing is dated in the future beyond a year).
 * ISO 'YYYY-MM-DD' is accepted too.
 */
export function parseFlisDate(raw, now = new Date()) {
  const t = (raw || '').trim();
  if (!t) return null;
  let y, mo, d, m;
  if ((m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(t))) {
    mo = MON[m[2].toUpperCase()];
    d = Number(m[1]);
    y = Number(m[3]);
    if (m[3].length === 2) {
      const cutoff = (now.getUTCFullYear() % 100) + 1;
      y += y <= cutoff ? 2000 : 1900;
    }
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    return null;
  }
  if (!mo || y < 1900 || y > 2100 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Trimmed text or null when blank. */
export function clean(raw) {
  const t = (raw ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Resolves {key: columnIndex|-1} for a layout [{key, names, pos}]. `keyName` is the layout key
 * whose header name decides whether the first line is a header at all: when none of its names is
 * in the first line, the file is read positionally and the first line is DATA.
 * `via` records header|position|absent per key for the log.
 */
export function resolveColumns(layout, firstFields, keyKey) {
  const keyDef = layout.find((c) => c.key === keyKey);
  const hasHeader = findColumnIndex(firstFields, keyDef.names) !== -1;
  const cols = {};
  const via = {};
  for (const c of layout) {
    if (hasHeader) {
      const idx = findColumnIndex(firstFields, c.names);
      if (idx !== -1) { cols[c.key] = idx; via[c.key] = 'header'; }
      else if (c.pos < firstFields.length) { cols[c.key] = c.pos; via[c.key] = 'position'; }
      else { cols[c.key] = -1; via[c.key] = 'absent'; }
    } else {
      cols[c.key] = c.pos; via[c.key] = 'position';
    }
  }
  return { cols, via, hasHeader };
}

export const at = (fields, idx) => (idx >= 0 && idx < fields.length ? fields[idx] : '');

export function describeColumns(label, res, headerLine) {
  const parts = Object.entries(res.cols).map(([k, i]) => `${k}=${i}(${res.via[k]})`).join(' ');
  return `load.mjs: ${label} ${res.hasHeader ? 'header row found' : 'NO header row; positional columns'}; resolved columns (0-based): ${parts}` +
    (res.hasHeader ? '' : ` [first line: ${headerLine.slice(0, 200)}]`);
}

export function distribution(values) {
  const d = {};
  for (const v of values) d[v ?? '-'] = (d[v ?? '-'] || 0) + 1;
  const e = Object.entries(d).sort(([a], [b]) => a.localeCompare(b));
  const shown = e.slice(0, 40).map(([k, n]) => `${k}:${n}`).join(' ');
  return e.length > 40 ? `${shown} ... (+${e.length - 40} more values)` : shown;
}

// ---------------------------------------------------------------------------
// Layouts (0-based `pos` = position in the files' real headers)
// ---------------------------------------------------------------------------

export const IDENT_LAYOUT = [
  { key: 'niin', names: ['NIIN'], pos: 0 },
  { key: 'inc', names: ['INC'], pos: 1 },
  { key: 'crit_cd', names: ['CRIT_CD'], pos: 3 },
  { key: 'demil', names: ['DMIL', 'DEMIL'], pos: 5 },
  { key: 'demil_int_cd', names: ['DMIL_INT_CD', 'DEMIL_INT_CD'], pos: 6 },
  { key: 'niin_assigned', names: ['NIIN_ASGMT'], pos: 7 },
  { key: 'pmic', names: ['PMIC'], pos: 8 },
  { key: 'adp', names: ['ADP'], pos: 9 },
  { key: 'hmic', names: ['HMIC'], pos: 10 },
  { key: 'esd_emi', names: ['ESD_EMI'], pos: 11 },
  { key: 'hcc', names: ['HCC'], pos: 12 },
  { key: 'schedule_b', names: ['SCHEDULE_B'], pos: 13 },
  { key: 'enac', names: ['ENAC'], pos: 14 },
  { key: 'iuid_indicator', names: ['IUID_INDICATOR'], pos: 15 },
  { key: 'last_known_sos', names: ['LST_KWN_SOS'], pos: 16 },
];
export const STDZN_LAYOUT = [
  { key: 'niin', names: ['NIIN'], pos: 0 },
  { key: 'related_nsn', names: ['RELATED_NSN'], pos: 1 },
  { key: 'isc', names: ['ISC'], pos: 2 },
  { key: 'orig_stdzn_dec', names: ['ORIG_STDZN_DEC'], pos: 3 },
  { key: 'stdzn_date', names: ['DT_STDZN_DEC'], pos: 4 },
  { key: 'niin_stat_cd', names: ['NIIN_STAT_CD'], pos: 5 },
];
export const CANCEL_LAYOUT = [
  { key: 'niin', names: ['NIIN'], pos: 0 },
  { key: 'cancelled_niin_fsc', names: ['CANCELLED_NIIN_FSC'], pos: 1 },
  { key: 'cancelled_niin', names: ['CANCELLED_NIIN'], pos: 2 },
  { key: 'niin_stat_cd', names: ['NIIN_STAT_CD'], pos: 3 },
  { key: 'eff_date', names: ['EFF_DATE'], pos: 4 },
  { key: 'demil', names: ['DEMIL', 'DMIL'], pos: 5 },
];
export const MOE_ALL_LAYOUT = [
  { key: 'niin', names: ['NIIN'], pos: 0 },
  { key: 'moe_rl', names: ['MOE_RL'], pos: 1 },
  { key: 'moe_cd', names: ['MOE_CD', 'MOE_CODE'], pos: 2 },
  { key: 'amc', names: ['AMC'], pos: 3 },
  { key: 'amsc', names: ['AMSC'], pos: 4 },
  { key: 'nimsc', names: ['NIMSC'], pos: 5 },
  { key: 'assigned_on', names: ['DT_ASGND'], pos: 6 },
  { key: 'imc', names: ['IMC'], pos: 7 },
  { key: 'imca', names: ['IMCA'], pos: 8 },
  { key: 'aac', names: ['AAC'], pos: 9 },
  { key: 'pica', names: ['PICA'], pos: 10 },
  { key: 'pica_loa', names: ['PICA_LOA'], pos: 11 },
  { key: 'sica', names: ['SICA'], pos: 12 },
  { key: 'sica_loa', names: ['SICA_LOA'], pos: 13 },
  { key: 'dsor', names: ['DSOR'], pos: 16 },
  { key: 'fmr_moe_rl', names: ['FMR_MOE_RL'], pos: 17 },
];
export const HELP_LAYOUT = [
  { key: 'code', names: ['CODE'], pos: 0 },
  { key: 'literal', names: ['LITERAL'], pos: 1 },
  { key: 'description', names: ['DESCRIPTION'], pos: 2 },
  { key: 'regs', names: ['REGS'], pos: 3 },
];
export const COLLOQUIAL_LAYOUT = [
  { key: 'inc', names: ['INC'], pos: 0 },
  { key: 'colloquial_name', names: ['COLLOQUIAL_NAME'], pos: 1 },
];

// ---------------------------------------------------------------------------
// Row mappers (pure). Return null to skip.
// ---------------------------------------------------------------------------

const hasAny = (obj, keys) => keys.some((k) => obj[k] !== null);

export function mapFlisIdentificationRow(f, cols, trackedByNiin, fileDate) {
  const niin = (at(f, cols.niin)).trim();
  const nsn = NIIN_RE.test(niin) ? trackedByNiin.get(niin) : undefined;
  if (!nsn) return null;
  const r = { nsn };
  for (const k of ['inc', 'crit_cd', 'demil', 'demil_int_cd', 'pmic', 'adp', 'hmic', 'esd_emi', 'hcc',
    'schedule_b', 'enac', 'iuid_indicator', 'last_known_sos']) r[k] = clean(at(f, cols[k]));
  r.niin_assigned = parseFlisDate(at(f, cols.niin_assigned));
  if (!hasAny(r, Object.keys(r).filter((k) => k !== 'nsn'))) return null; // nothing but the key
  r.source_file_date = fileDate;
  return r;
}

export function mapStandardizationRow(f, cols, trackedByNiin) {
  const niin = at(f, cols.niin).trim();
  const nsn = NIIN_RE.test(niin) ? trackedByNiin.get(niin) : undefined;
  if (!nsn) return null;
  const r = {
    nsn,
    related_nsn: (at(f, cols.related_nsn)).replace(/[^0-9A-Za-z]/g, '').toUpperCase(),
    isc: clean(at(f, cols.isc)),
    orig_stdzn_dec: clean(at(f, cols.orig_stdzn_dec)),
    stdzn_date: parseFlisDate(at(f, cols.stdzn_date)),
    niin_stat_cd: clean(at(f, cols.niin_stat_cd)),
  };
  // Status alone carries nothing beyond pub.nsn_identification-level facts: skip.
  if (r.related_nsn === '' && r.isc === null && r.orig_stdzn_dec === null && at(f, cols.stdzn_date).trim() === '') return null;
  return r;
}

export function mapCancellationRow(f, cols, trackedByNiin) {
  const niin = at(f, cols.niin).trim();
  const cancelled = at(f, cols.cancelled_niin).trim();
  if (!NIIN_RE.test(niin) || !NIIN_RE.test(cancelled)) return null;
  const nsn = trackedByNiin.get(niin) || trackedByNiin.get(cancelled);
  if (!nsn) return null;
  return {
    niin,
    cancelled_niin_fsc: clean(at(f, cols.cancelled_niin_fsc)),
    cancelled_niin: cancelled,
    niin_stat_cd: clean(at(f, cols.niin_stat_cd)),
    eff_date: parseFlisDate(at(f, cols.eff_date)),
    demil: clean(at(f, cols.demil)),
    nsn,
  };
}

export function mapMoeAllRow(f, cols, trackedByNiin) {
  const niin = at(f, cols.niin).trim();
  const nsn = NIIN_RE.test(niin) ? trackedByNiin.get(niin) : undefined;
  const moeRl = clean(at(f, cols.moe_rl));
  if (!nsn || !moeRl) return null;
  const r = { nsn, moe_rl: moeRl.toUpperCase() };
  for (const k of ['moe_cd', 'amc', 'amsc', 'nimsc', 'imc', 'imca', 'aac', 'pica', 'pica_loa',
    'sica', 'sica_loa', 'dsor', 'fmr_moe_rl']) r[k] = clean(at(f, cols[k]));
  r.assigned_on = parseFlisDate(at(f, cols.assigned_on));
  return r;
}

// ---------------------------------------------------------------------------
// Batched upsert
// ---------------------------------------------------------------------------

/**
 * Multi-row INSERT ... ON CONFLICT DO UPDATE in one statement (unnest of one array per column,
 * so no parameter-count limit). Rows already identical to the stored row are not touched
 * (WHERE ... IS DISTINCT FROM), so the returned count is inserted + really-changed rows.
 * Duplicate keys inside one batch are collapsed (last wins): Postgres rejects them otherwise.
 *
 * @param {{table: string, cols: [string,string][], key: string[], touch?: string}} spec
 *        cols = [name, pgType]; touch = extra "col = now()" assignment on update
 */
export function buildUpsert({ table, cols, key, touch }) {
  const names = cols.map(([n]) => n);
  const nonKey = names.filter((n) => !key.includes(n));
  const unnest = cols.map(([, t], i) => `$${i + 1}::${t}[]`).join(', ');
  const set = nonKey.map((n) => `${n} = EXCLUDED.${n}`).concat(touch ? [touch] : []).join(', ');
  const sql =
    `INSERT INTO ${table} (${names.join(', ')})\n` +
    `SELECT * FROM unnest(${unnest}) AS t(${names.join(', ')})\n` +
    (nonKey.length === 0
      ? `ON CONFLICT (${key.join(', ')}) DO NOTHING`
      : `ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${set}\nWHERE (${nonKey.map((n) => `${table}.${n}`).join(', ')}) IS DISTINCT FROM (${nonKey.map((n) => `EXCLUDED.${n}`).join(', ')})`);
  return sql;
}

export function makeWriter(spec) {
  const sql = buildUpsert(spec);
  const names = spec.cols.map(([n]) => n);
  const pending = new Map();
  let written = 0;
  const flush = async () => {
    if (pending.size === 0) return;
    const rows = [...pending.values()];
    pending.clear();
    const params = names.map((n) => rows.map((r) => r[n] ?? null));
    const res = await withRetry(() => getPool().query(sql, params), { label: spec.table });
    written += res.rowCount;
  };
  return {
    sql,
    async add(row) {
      pending.set(spec.key.map((k) => row[k]).join('\u0001'), row);
      if (pending.size >= BATCH) await flush();
    },
    flush,
    get written() { return written; },
  };
}

const T = {
  ident: {
    table: 'pub.nsn_identification',
    key: ['nsn'],
    touch: 'updated_at = now()',
    cols: [['nsn', 'text'], ['inc', 'text'], ['crit_cd', 'text'], ['demil', 'text'], ['demil_int_cd', 'text'],
      ['niin_assigned', 'date'], ['pmic', 'text'], ['adp', 'text'], ['hmic', 'text'], ['esd_emi', 'text'],
      ['hcc', 'text'], ['schedule_b', 'text'], ['enac', 'text'], ['iuid_indicator', 'text'],
      ['last_known_sos', 'text'], ['source_file_date', 'date']],
  },
  stdzn: {
    table: 'pub.nsn_standardization',
    key: ['nsn', 'related_nsn'],
    cols: [['nsn', 'text'], ['related_nsn', 'text'], ['isc', 'text'], ['orig_stdzn_dec', 'text'],
      ['stdzn_date', 'date'], ['niin_stat_cd', 'text']],
  },
  cancel: {
    table: 'pub.nsn_cancellations',
    key: ['niin', 'cancelled_niin'],
    cols: [['niin', 'text'], ['cancelled_niin_fsc', 'text'], ['cancelled_niin', 'text'], ['niin_stat_cd', 'text'],
      ['eff_date', 'date'], ['demil', 'text'], ['nsn', 'text']],
  },
  moe: {
    table: 'pub.moe_rules',
    key: ['nsn', 'moe_rl'],
    cols: [['nsn', 'text'], ['moe_rl', 'text'], ['moe_cd', 'text'], ['amc', 'text'], ['amsc', 'text'],
      ['nimsc', 'text'], ['assigned_on', 'date'], ['imc', 'text'], ['imca', 'text'], ['aac', 'text'],
      ['pica', 'text'], ['pica_loa', 'text'], ['sica', 'text'], ['sica_loa', 'text'], ['dsor', 'text'],
      ['fmr_moe_rl', 'text']],
  },
  codes: {
    table: 'pub.flis_codes',
    key: ['code'],
    cols: [['code', 'text'], ['literal', 'text'], ['description', 'text'], ['regs', 'text']],
  },
  colloquial: {
    table: 'pub.inc_colloquial_names',
    key: ['inc', 'colloquial_name'],
    cols: [['inc', 'text'], ['colloquial_name', 'text']],
  },
};
export const UPSERT_SPECS = T;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Lines -> field arrays. With `multiline`, a record whose quotes are unbalanced is joined with the next line(s). */
async function* records(filePath, { multiline = false } = {}) {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let carry = null;
  try {
    for await (const line of rl) {
      let rec = line;
      if (multiline) {
        if (carry !== null) rec = `${carry}\n${line}`;
        const quotes = rec.split('"').length - 1;
        if (quotes % 2 === 1) { carry = rec; continue; }
        carry = null;
      }
      if (rec === '') continue;
      yield { line: rec, fields: null };
    }
    if (carry !== null) yield { line: carry, fields: null }; // unterminated quote at EOF: parse what we have
  } finally {
    rl.close();
  }
}

/**
 * Shared driver: resolves columns from the first line, then calls onRow(fields, cols) for each
 * data row. `prefilter(line)` may return false to skip a line without splitting it (tracked-NIIN
 * check on the huge files); it must return null/true when unsure.
 */
export async function scan(filePath, label, layout, keyKey, onRow, { log, prefilter, multiline } = {}) {
  let res = null;
  let scanned = 0;
  let bad = 0;
  // meta = {cols, headers}: handed to onRow (3rd argument) and prefilter (2nd argument) so a loader can
  // record source column names or decide whether the first-field NIIN shortcut is safe for this file.
  const meta = { cols: null, headers: null };
  for await (const { line } of records(filePath, { multiline })) {
    if (!res) {
      const first = splitCsvLine(line);
      res = resolveColumns(layout, first, keyKey);
      meta.cols = res.cols;
      meta.headers = res.hasHeader ? first : null;
      log(describeColumns(label, res, line));
      if (res.hasHeader) continue;
      scanned += 1;
      try {
        await onRow(first, res.cols, meta);
      } catch (e) {
        if (e && e.isDb) throw e;
        bad += 1;
      }
      continue;
    }
    scanned += 1;
    if (prefilter && prefilter(line, meta) === false) continue;
    try {
      await onRow(splitCsvLine(line), res.cols, meta);
    } catch (e) {
      if (e && e.isDb) throw e;
      bad += 1; // malformed row: count and move on
    }
  }
  if (!res) log(`load.mjs: ${label}: file is empty`);
  return { scanned, bad };
}

// A DB failure must abort the loader (it is reported as a warning by main); only mapping
// problems are per-row.
export function dbGuard(writer) {
  return async (row) => {
    try { await writer.add(row); } catch (e) { e.isDb = true; throw e; }
  };
}

export async function fileDateOf(filePath, override) {
  if (override) return override;
  try { return (await stat(filePath)).mtime.toISOString().slice(0, 10); } catch { return null; }
}

const defLog = (m) => console.log(m);

/** V_FLIS_IDENTIFICATION.CSV -> pub.nsn_identification */
export async function loadFlisIdentification(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const fileDate = await fileDateOf(filePath, opts.sourceFileDate);
  const w = makeWriter(T.ident);
  const kept = [];
  const add = dbGuard(w);
  const { scanned, bad } = await scan(filePath, 'V_FLIS_IDENTIFICATION.CSV', IDENT_LAYOUT, 'niin', async (f, cols) => {
    const r = mapFlisIdentificationRow(f, cols, trackedByNiin, fileDate);
    if (!r) return;
    kept.push(r);
    await add(r);
  }, { log, prefilter: (l) => quickNiinTracked(l, trackedByNiin) });
  await w.flush();
  log(`load.mjs: V_FLIS_IDENTIFICATION.CSV: ${scanned} rows scanned, ${kept.length} on tracked NIINs, ${bad} malformed row(s) skipped, ${w.written} written`);
  log(`load.mjs: V_FLIS_IDENTIFICATION.CSV DEMIL distribution: ${distribution(kept.map((r) => r.demil))}`);
  log(`load.mjs: V_FLIS_IDENTIFICATION.CSV CRIT_CD distribution: ${distribution(kept.map((r) => r.crit_cd))}`);
  return { scanned, kept: kept.length, written: w.written };
}

/** V_FLIS_STANDARDIZATION.CSV -> pub.nsn_standardization */
export async function loadStandardization(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.stdzn);
  const add = dbGuard(w);
  let kept = 0;
  const statuses = [];
  const { scanned, bad } = await scan(filePath, 'V_FLIS_STANDARDIZATION.CSV', STDZN_LAYOUT, 'niin', async (f, cols) => {
    const r = mapStandardizationRow(f, cols, trackedByNiin);
    if (!r) return;
    kept += 1;
    statuses.push(r.niin_stat_cd);
    await add(r);
  }, { log, prefilter: (l) => quickNiinTracked(l, trackedByNiin) });
  await w.flush();
  log(`load.mjs: V_FLIS_STANDARDIZATION.CSV: ${scanned} rows scanned, ${kept} kept (tracked NIIN with related NSN / ISC / decision), ${bad} malformed row(s) skipped, ${w.written} written`);
  log(`load.mjs: V_FLIS_STANDARDIZATION.CSV NIIN_STAT_CD distribution: ${distribution(statuses)}`);
  return { scanned, kept, written: w.written };
}

/** V_FLIS_CANCELLED_NIIN.CSV -> pub.nsn_cancellations (tracked NIIN on either side) */
export async function loadCancelledNiin(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.cancel);
  const add = dbGuard(w);
  const kept = [];
  const { scanned, bad } = await scan(filePath, 'V_FLIS_CANCELLED_NIIN.CSV', CANCEL_LAYOUT, 'niin', async (f, cols) => {
    const r = mapCancellationRow(f, cols, trackedByNiin);
    if (!r) return;
    kept.push(r);
    await add(r);
  }, { log }); // either column can match, so no first-field prefilter (49 MB file)
  await w.flush();
  log(`load.mjs: V_FLIS_CANCELLED_NIIN.CSV: ${scanned} rows scanned, ${kept.length} involving a tracked NIIN, ${bad} malformed row(s) skipped, ${w.written} written`);
  log(`load.mjs: V_FLIS_CANCELLED_NIIN.CSV DEMIL distribution: ${distribution(kept.map((r) => r.demil))}`);
  log(`load.mjs: V_FLIS_CANCELLED_NIIN.CSV NIIN_STAT_CD distribution: ${distribution(kept.map((r) => r.niin_stat_cd))}`);
  return { scanned, kept: kept.length, written: w.written };
}

/**
 * All V_MOE_RULE.CSV rows of tracked NIINs -> pub.moe_rules, WITHOUT a second read of the 1.7 GB
 * file: returns {tap, finish}. Pass `tap` as opts.tap to loadMoeRule / collectMoeRule, then await
 * finish({scanned}). A database error is held (the MOE amsc load must not be affected) and
 * rethrown from finish().
 */
export function createMoeRulesAllLoader(trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.moe);
  let cols = null;
  let dead = null;
  let kept = 0;
  let bad = 0;
  const moeCds = new Map();
  const header = (fields, looksLikeData) => {
    const res = resolveColumns(MOE_ALL_LAYOUT, looksLikeData ? [] : fields, 'niin');
    cols = res.cols;
    log(describeColumns('V_MOE_RULE.CSV (all rules)', { ...res, hasHeader: !looksLikeData }, fields.join(',')));
  };
  return {
    tap: {
      header,
      async row(fields) {
        if (dead) return;
        try {
          const r = mapMoeAllRow(fields, cols, trackedByNiin);
          if (!r) return;
          kept += 1;
          moeCds.set(r.moe_cd ?? '-', (moeCds.get(r.moe_cd ?? '-') || 0) + 1);
          await w.add(r);
        } catch (e) {
          if (e && e.code) dead = e; // pg error: stop writing, report from finish()
          else bad += 1;
        }
      },
    },
    async finish({ scanned }) {
      if (!dead) { try { await w.flush(); } catch (e) { dead = e; } }
      log(`load.mjs: V_MOE_RULE.CSV (all rules): ${scanned} rows scanned, ${kept} on tracked NIINs, ${bad} malformed row(s) skipped, ${w.written} written`);
      log(`load.mjs: V_MOE_RULE.CSV MOE_CD distribution (tracked rows): ${[...moeCds].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(' ')}`);
      if (dead) throw dead;
      return { scanned, kept, written: w.written };
    },
  };
}

/**
 * Standalone variant: its own pass over a MOE file (used by tests and ad-hoc runs; main() shares
 * the pass with loadMoeRule via createMoeRulesAllLoader instead).
 */
export async function loadMoeRulesAll(filePath, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.moe);
  const add = dbGuard(w);
  const cds = [];
  let kept = 0;
  const { scanned, bad } = await scan(filePath, 'V_MOE_RULE.CSV (all rules)', MOE_ALL_LAYOUT, 'niin', async (f, cols) => {
    const r = mapMoeAllRow(f, cols, trackedByNiin);
    if (!r) return;
    kept += 1; cds.push(r.moe_cd);
    await add(r);
  }, { log, prefilter: (l) => quickNiinTracked(l, trackedByNiin) });
  await w.flush();
  log(`load.mjs: V_MOE_RULE.CSV (all rules): ${scanned} rows scanned, ${kept} on tracked NIINs, ${bad} malformed row(s) skipped, ${w.written} written`);
  log(`load.mjs: V_MOE_RULE.CSV MOE_CD distribution (tracked rows): ${distribution(cds)}`);
  return { scanned, kept, written: w.written };
}

/** P_HELP.CSV -> pub.flis_codes (whole file; a repeated CODE keeps the last row and is counted). */
export async function loadFlisCodes(filePath, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.codes);
  const add = dbGuard(w);
  const seen = new Set();
  let dup = 0;
  let kept = 0;
  const { scanned, bad } = await scan(filePath, 'P_HELP.CSV', HELP_LAYOUT, 'code', async (f, cols) => {
    const code = clean(at(f, cols.code));
    if (!code) return;
    if (seen.has(code)) dup += 1; else seen.add(code);
    kept += 1;
    await add({ code, literal: clean(at(f, cols.literal)), description: clean(at(f, cols.description)), regs: clean(at(f, cols.regs)) });
  }, { log, multiline: true });
  await w.flush();
  log(`load.mjs: P_HELP.CSV: ${scanned} rows scanned, ${kept} kept (${seen.size} distinct codes, ${dup} repeated CODE value(s) collapsed to the last row), ${bad} malformed row(s) skipped, ${w.written} written`);
  return { scanned, kept, written: w.written };
}

/** V_COLLOQUIAL_NAME.CSV -> pub.inc_colloquial_names (whole file). */
export async function loadColloquialNames(filePath, opts = {}) {
  const log = opts.log || defLog;
  const w = makeWriter(T.colloquial);
  const add = dbGuard(w);
  let kept = 0;
  const { scanned, bad } = await scan(filePath, 'V_COLLOQUIAL_NAME.CSV', COLLOQUIAL_LAYOUT, 'inc', async (f, cols) => {
    const inc = clean(at(f, cols.inc));
    const name = clean(at(f, cols.colloquial_name));
    if (!inc || !name) return;
    kept += 1;
    await add({ inc, colloquial_name: name });
  }, { log, multiline: true });
  await w.flush();
  log(`load.mjs: V_COLLOQUIAL_NAME.CSV: ${scanned} rows scanned, ${kept} kept, ${bad} malformed row(s) skipped, ${w.written} written`);
  return { scanned, kept, written: w.written };
}
