// ingest/publog/load-freight-packaging.mjs
// Loader for DLA's PUB LOG freight and packaging files (FREIGHT_PACKAGING.zip) (migration 0023):
//
//   V_FLIS_PACKAGING_1.CSV  -> pub.nsn_packaging       (preservation / packaging codes, unpackaged item size)
//   V_FLIS_PACKAGING_2.CSV  -> pub.nsn_packaging       (special marking, packing levels, unit pack weight / size / cube)
//   V_FLIS_PACKAGING_3.CSV  -> pub.nsn_packaging       (packaging design activity, special packaging instruction)
//   V_FREIGHT.CSV           -> pub.nsn_freight         (NMFC / UFC freight classification and related codes)
//   V_DSS_WEIGHT_AND_CUBE.CSV -> pub.nsn_dss_weight_cube
//
// LAYOUT STATUS: the headers of the first four files were read from the real zip (dated 2026-10-27) and are
// listed below by exact name. V_DSS_WEIGHT_AND_CUBE.CSV (NIIN, DSS_WEIGHT, DSS_CUBE) is named in DLA's layout
// document but is NOT in the zip today: its header is UNVERIFIED, it is loaded only when the file shows up,
// and a missing one is a plain log line, not a warning.
//
// Rules that keep a wrong guess from loading wrong data:
//   - columns are resolved by EXACT header name only: no alias lists, no positional fallback.
//   - a file with no header row is refused.
//   - if ANY mapped column of a file is missing from its header, that file is refused with an error naming the
//     missing columns (writing NULLs over stored values would destroy data). The other files still load.
//   - header columns the layout does not know are logged in one line; they are not stored.
//
// Keys: the three packaging files share (nsn, pica_sica) in pub.nsn_packaging. Each file is scanned and
// checked on its own, its mapped rows are collected in memory, and after the three scans the partial rows are
// merged by key and written ONCE (buildPackagingWrite), so a row costs one write, not three. The write lists
// only the columns of the files that loaded: a file that was refused, failed or is missing contributes no
// columns, so its stored columns are never overwritten with NULL. V_FREIGHT.CSV and V_DSS_WEIGHT_AND_CUBE.CSV
// are one row per NSN and are written per file. No table has a source_file_date column: it would change every
// month and force a rewrite of every row; updated_at moves only when a published value really changes.
//
// Values: text is stored as published (trimmed, blank -> NULL; placeholders such as 'ZZ' and '00' are kept).
// Numbers go through parseMeasure: zero means "not recorded" in these files and is stored as NULL.
//
// Same rules as load-flis.mjs / load-management.mjs otherwise: enrich-only (NIINs not in pub.nsns are
// skipped), streamed line by line, batched single-statement upserts, never deletes, an unchanged row is not
// rewritten (a second run reports written = 0).

import path from 'node:path';
import { splitCsvLine, quickNiinTracked, NIIN_RE } from './load.mjs';
import {
  at, clean, distribution, makeWriter, scan, dbGuard, resolveColumns,
} from './load-flis.mjs';
import { readHeadLine } from './load-management.mjs';

// ---------------------------------------------------------------------------
// Layouts (exact header names; pos -1 = never read by position)
// ---------------------------------------------------------------------------

const col = (key) => ({ key, names: [key.toUpperCase()], pos: -1 });
const layoutOf = (keys) => [{ key: 'niin', names: ['NIIN'], pos: 0 }, ...keys.map(col)];

const PKG1_VALUES = ['pkg_cat', 'unpkg_item_weight', 'unpkg_item_width', 'unpkg_item_length', 'unpkg_item_height', 'ui', 'tos', 'icq',
  'mop', 'clng_drying', 'pres_mat', 'wrap_mat', 'cush_dun', 'thk', 'unit_cont', 'pkg_data_source'];
const PKG2_VALUES = ['spc_mkg', 'inter_cont', 'ucl', 'lvl_a', 'lvl_b', 'lvl_c', 'unit_pack_weight', 'up_sz_maxb', 'up_sz_maxl',
  'up_sz_maxh', 'unit_pack_cube', 'opi', 'supplemental_instructions'];
const PKG3_VALUES = ['pkg_design_acty', 'spi_no', 'spi_rev', 'spi_date', 'cont_nsn'];
// acty_cd is not counted as a value: a freight row that carries only an activity code has no freight data.
const FREIGHT_VALUES = ['nmfc', 'nmfc_sub', 'ufc', 'hmc', 'ltl', 'lcl', 'rvc', 'wcc', 'tcc', 'shc', 'adc', 'acc', 'integ', 'nmf_desc'];
const DSS_VALUES = ['dss_weight', 'dss_cube'];

const PKG1_NUM = ['unpkg_item_weight', 'unpkg_item_width', 'unpkg_item_length', 'unpkg_item_height'];
const PKG2_NUM = ['unit_pack_weight', 'up_sz_maxb', 'up_sz_maxl', 'up_sz_maxh', 'unit_pack_cube'];

export const PKG1_LAYOUT = layoutOf(['pica_sica', ...PKG1_VALUES]);
export const PKG2_LAYOUT = layoutOf(['pica_sica', ...PKG2_VALUES]);
export const PKG3_LAYOUT = layoutOf(['pica_sica', ...PKG3_VALUES]);
export const FREIGHT_LAYOUT = layoutOf(['acty_cd', ...FREIGHT_VALUES]);
export const DSS_LAYOUT = layoutOf(DSS_VALUES); // header UNVERIFIED (see the top of this file)

/** Value columns written by each packaging file (for the merged write and its tests). */
export const PKG1_COLUMNS = PKG1_VALUES;
export const PKG2_COLUMNS = PKG2_VALUES;
export const PKG3_COLUMNS = PKG3_VALUES;

const pgType = (k) => (PKG1_NUM.includes(k) || PKG2_NUM.includes(k) || DSS_VALUES.includes(k) ? 'numeric' : 'text');
const specCols = (keys) => keys.map((k) => [k, pgType(k)]);

/**
 * Upsert specs. The packaging spec is built per run by buildPackagingWrite (it depends on which of the three
 * packaging files loaded); freight and DSS are single-file tables.
 */
export const FREIGHT_UPSERT = {
  table: 'pub.nsn_freight', key: ['nsn'], touch: 'updated_at = now()',
  cols: [['nsn', 'text'], ['acty_cd', 'text'], ...specCols(FREIGHT_VALUES)],
};
export const DSS_UPSERT = {
  table: 'pub.nsn_dss_weight_cube', key: ['nsn'], touch: 'updated_at = now()',
  cols: [['nsn', 'text'], ...specCols(DSS_VALUES)],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Number text -> canonical decimal string, or null when blank, not a plain non-negative decimal, or zero
 * (zero means "not recorded" in these files). The text is kept as written: '1350.0000' stays '1350.0000'.
 */
export function parseMeasure(raw) {
  const t = clean(raw);
  if (t === null) return null;
  if (!/^\d{1,15}(\.\d{1,10})?$/.test(t)) return null;
  if (/^0*(\.0*)?$/.test(t)) return null;
  return t;
}

/** Placeholder 'no date' text of PACKAGING_3 (SPI_DATE '00000') -> null. */
const spiDate = (raw) => {
  const t = clean(raw);
  return t === null || /^0+$/.test(t) ? null : t;
};

const trackedNsn = (f, cols, trackedByNiin) => {
  const niin = at(f, cols.niin).trim();
  return NIIN_RE.test(niin) ? trackedByNiin.get(niin) : undefined;
};
const picaOf = (f, cols) => (clean(at(f, cols.pica_sica)) ?? '').toUpperCase();
const hasValue = (r, keys) => keys.some((k) => r[k] !== null);

export function mapPackaging1Row(f, cols, trackedByNiin) {
  const nsn = trackedNsn(f, cols, trackedByNiin);
  if (!nsn) return null;
  const r = { nsn, pica_sica: picaOf(f, cols) };
  for (const k of PKG1_VALUES) r[k] = PKG1_NUM.includes(k) ? parseMeasure(at(f, cols[k])) : clean(at(f, cols[k]));
  return hasValue(r, PKG1_VALUES) ? r : null;
}

export function mapPackaging2Row(f, cols, trackedByNiin) {
  const nsn = trackedNsn(f, cols, trackedByNiin);
  if (!nsn) return null;
  const r = { nsn, pica_sica: picaOf(f, cols) };
  for (const k of PKG2_VALUES) r[k] = PKG2_NUM.includes(k) ? parseMeasure(at(f, cols[k])) : clean(at(f, cols[k]));
  return hasValue(r, PKG2_VALUES) ? r : null;
}

export function mapPackaging3Row(f, cols, trackedByNiin) {
  const nsn = trackedNsn(f, cols, trackedByNiin);
  if (!nsn) return null;
  const r = { nsn, pica_sica: picaOf(f, cols) };
  for (const k of PKG3_VALUES) r[k] = k === 'spi_date' ? spiDate(at(f, cols[k])) : clean(at(f, cols[k]));
  return hasValue(r, PKG3_VALUES) ? r : null;
}

export function mapFreightRow(f, cols, trackedByNiin) {
  const nsn = trackedNsn(f, cols, trackedByNiin);
  if (!nsn) return null;
  const r = { nsn, acty_cd: clean(at(f, cols.acty_cd)) };
  for (const k of FREIGHT_VALUES) r[k] = clean(at(f, cols[k]));
  return hasValue(r, FREIGHT_VALUES) ? r : null;
}

export function mapDssRow(f, cols, trackedByNiin) {
  const nsn = trackedNsn(f, cols, trackedByNiin);
  if (!nsn) return null;
  const r = { nsn };
  for (const k of DSS_VALUES) r[k] = parseMeasure(at(f, cols[k]));
  return hasValue(r, DSS_VALUES) ? r : null;
}

/** Everything the loader needs to know about one file kind, in load order. */
export const KINDS = [
  { kind: 'PACKAGING_1', file: 'V_FLIS_PACKAGING_1.CSV', layout: PKG1_LAYOUT, map: mapPackaging1Row, values: PKG1_VALUES, nums: PKG1_NUM,
    merged: true, keyOf: (r) => `${r.nsn}|${r.pica_sica}`, codes: ['pkg_cat', 'tos', 'mop', 'pkg_data_source'], topCodes: ['pkg_cat'] },
  { kind: 'PACKAGING_2', file: 'V_FLIS_PACKAGING_2.CSV', layout: PKG2_LAYOUT, map: mapPackaging2Row, values: PKG2_VALUES, nums: PKG2_NUM,
    merged: true, keyOf: (r) => `${r.nsn}|${r.pica_sica}`, codes: ['spc_mkg', 'ucl', 'lvl_a', 'lvl_b', 'lvl_c', 'opi'], topCodes: [] },
  { kind: 'PACKAGING_3', file: 'V_FLIS_PACKAGING_3.CSV', layout: PKG3_LAYOUT, map: mapPackaging3Row, values: PKG3_VALUES, nums: [],
    merged: true, keyOf: (r) => `${r.nsn}|${r.pica_sica}`, codes: [], topCodes: [] },
  { kind: 'FREIGHT', file: 'V_FREIGHT.CSV', layout: FREIGHT_LAYOUT, spec: FREIGHT_UPSERT, map: mapFreightRow, values: FREIGHT_VALUES, nums: [],
    keyOf: (r) => r.nsn, codes: ['acty_cd', 'ltl', 'lcl', 'hmc', 'tcc', 'shc', 'integ'], topCodes: [] },
  { kind: 'DSS', file: 'V_DSS_WEIGHT_AND_CUBE.CSV', layout: DSS_LAYOUT, spec: DSS_UPSERT, map: mapDssRow, values: DSS_VALUES, nums: DSS_VALUES,
    keyOf: (r) => r.nsn, codes: [], topCodes: [], optionalFile: true },
];

/**
 * Merges the partial packaging rows of the files that loaded into one row per (nsn, pica_sica) and builds the
 * single upsert spec for them. `partsByKind` = {PACKAGING_1: rows, PACKAGING_2: rows, ...} holding ONLY the
 * kinds that loaded (rows: any iterable of mapped rows). The spec lists nsn, pica_sica and the value columns of
 * those kinds only, so the columns of a kind that did not load are left untouched in the table. Inside a
 * loaded kind, a key that file does not have gets NULL for that kind's columns (that is what the source says).
 * Returns {spec, rows, keyCounts: {1, 2, 3}} (keys that came from 1, 2, 3 files); spec is null when no kind loaded.
 */
export function buildPackagingWrite(partsByKind) {
  const kinds = KINDS.filter((k) => k.merged && partsByKind[k.kind] !== undefined);
  if (kinds.length === 0) return { spec: null, rows: [], keyCounts: { 1: 0, 2: 0, 3: 0 } };
  const merged = new Map();
  const fileCount = new Map(); // key -> number of loaded files that have it
  for (const k of kinds) {
    const inThisFile = new Set();
    for (const r of partsByKind[k.kind]) {
      const key = `${r.nsn}|${r.pica_sica}`;
      let m = merged.get(key);
      if (!m) {
        m = { nsn: r.nsn, pica_sica: r.pica_sica };
        for (const kk of kinds) for (const c of kk.values) m[c] = null;
        merged.set(key, m);
      }
      Object.assign(m, r);
      if (!inThisFile.has(key)) { inThisFile.add(key); fileCount.set(key, (fileCount.get(key) || 0) + 1); }
    }
  }
  const keyCounts = { 1: 0, 2: 0, 3: 0 };
  for (const key of merged.keys()) keyCounts[fileCount.get(key)] += 1;
  const spec = {
    table: 'pub.nsn_packaging', key: ['nsn', 'pica_sica'], touch: 'updated_at = now()',
    cols: [['nsn', 'text'], ['pica_sica', 'text'], ...kinds.flatMap((k) => specCols(k.values))],
  };
  return { spec, rows: [...merged.values()], keyCounts };
}

/** Which files of a directory listing are freight / packaging files: [{file, kind}] in load order. Exact names, any case. */
export function findFreightPackagingFiles(filesOnDisk) {
  const out = [];
  for (const k of KINDS) {
    const file = filesOnDisk.find((f) => f.toUpperCase() === k.file);
    if (file) out.push({ file, kind: k.kind });
  }
  return out;
}

/**
 * Checks the first line of a file against its layout. Throws (naming the columns) when there is no header row or
 * any mapped column is missing. Returns {unknown}: header names the layout does not know.
 */
export function checkHeader(label, layout, headLine) {
  const first = splitCsvLine(headLine || '');
  const res = resolveColumns(layout, first, 'niin');
  if (!res.hasHeader) throw new Error(`${label}: no header row; refusing to read it by position. First line: ${(headLine || '').slice(0, 300)}`);
  const missing = layout.filter((c) => !first.some((h) => h.trim().toUpperCase() === c.names[0])).map((c) => c.names[0]);
  if (missing.length > 0) throw new Error(`${label}: header is missing mapped column(s) ${missing.join(', ')}; refusing the file (NULLs would overwrite stored values)`);
  const known = new Set(layout.map((c) => c.names[0]));
  return { unknown: first.filter((h) => !known.has(h.trim().toUpperCase())) };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const defLog = (m) => console.log(m);
const fatal = (msg) => Object.assign(new Error(msg), { isDb: true }); // isDb makes scan() abort instead of counting a bad row

const median = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

/** Distribution limited to the n most frequent values; the rest is summarised. */
function topDistribution(values, n = 30) {
  const counts = new Map();
  for (const v of values) counts.set(v ?? '-', (counts.get(v ?? '-') || 0) + 1);
  const top = new Set([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k));
  const shown = distribution(values.filter((v) => top.has(v ?? '-')));
  return counts.size > n ? `${shown} ... (top ${n} of ${counts.size} values)` : shown;
}

/**
 * One file -> its table. Throws when the header is unusable (see checkHeader). Returns
 * {scanned, kept, empty, bad, dupKeys, written, rows, stats, firstRows}; stats holds the values for the summary only.
 * For a packaging kind nothing is written (written 0) and `rows` holds the mapped rows for buildPackagingWrite.
 */
export async function loadFreightPackagingFile(filePath, kindName, trackedByNiin, opts = {}) {
  const k = KINDS.find((x) => x.kind === kindName);
  if (!k) throw new Error(`load-freight-packaging: unknown kind ${kindName}`);
  const log = opts.log || defLog;
  const label = path.basename(filePath);
  const headLine = await readHeadLine(filePath);
  log(`load.mjs: ${label} first line: ${(headLine || '').slice(0, 1000)}`);
  const { unknown } = checkHeader(label, k.layout, headLine);
  log(`load.mjs: ${label} header names not in the layout (not stored): ${unknown.join(', ') || '(none)'}`);

  // Packaging files are not written here: their rows are collected in `rows` and written once, merged.
  const w = k.merged ? null : makeWriter(k.spec);
  const add = w ? dbGuard(w) : null;
  const rows = new Map();
  const seenKeys = new Set();
  let dupKeys = 0;
  let kept = 0;
  let empty = 0;
  const stats = { codes: Object.fromEntries(k.codes.map((c) => [c, []])), nums: Object.fromEntries(k.nums.map((c) => [c, []])), unparsable: {} };
  const firstRows = [];
  const { scanned, bad } = await scan(filePath, label, k.layout, 'niin', async (f, _cols, meta) => {
    if (meta.headers === null) throw fatal(`${label}: no header row; refusing to read it by position`);
    const cols = meta.cols;
    if (!trackedNsn(f, cols, trackedByNiin)) return;
    const r = k.map(f, cols, trackedByNiin);
    if (!r) { empty += 1; return; }
    kept += 1;
    const key = k.keyOf(r);
    if (seenKeys.has(key)) dupKeys += 1; else seenKeys.add(key);
    // Summary data only (short codes and numbers; never the long text columns).
    for (const c of k.codes) stats.codes[c].push(r[c]);
    for (const c of k.nums) {
      if (r[c] !== null) stats.nums[c].push(Number(r[c]));
      else if (!/^0*(\.0*)?$/.test((at(f, cols[c]) || '').trim())) stats.unparsable[c] = (stats.unparsable[c] || 0) + 1;
    }
    if (firstRows.length < 3) firstRows.push(r);
    if (add) await add(r); else rows.set(key, r); // a repeated key keeps the last row, like the writer
  }, {
    log,
    // The first-field shortcut is only valid when NIIN is column 0 of this file.
    prefilter: (l, meta) => (meta && meta.cols && meta.cols.niin === 0 ? quickNiinTracked(l, trackedByNiin) : null),
  });
  if (w) await w.flush();

  log(`load.mjs: ${label}: ${scanned} rows scanned, ${kept} kept on tracked NIINs, ${empty} skipped as empty, ${bad} malformed row(s) skipped, ${dupKeys} repeated key(s) collapsed to the last row${w ? `, ${w.written} written` : ' (written once with the other packaging files)'}`);
  for (const c of k.codes) {
    log(`load.mjs: ${label} ${c.toUpperCase()} distribution (kept rows): ${k.topCodes.includes(c) ? topDistribution(stats.codes[c]) : distribution(stats.codes[c])}`);
  }
  for (const c of k.nums) {
    const v = stats.nums[c];
    const s = { nonNull: v.length, unparsable: stats.unparsable[c] || 0, min: v.length ? Math.min(...v) : null, median: median(v), max: v.length ? Math.max(...v) : null };
    log(`load.mjs: ${label} ${c.toUpperCase()} values: ${JSON.stringify(s)}`);
  }
  for (const r of firstRows) log(`load.mjs: ${label} sample mapped row: ${JSON.stringify(r)}`);
  return { scanned, kept, empty, bad, dupKeys, written: w ? w.written : 0, rows: k.merged ? [...rows.values()] : null, stats, firstRows };
}

/**
 * Loads the freight / packaging files. `files` is findFreightPackagingFiles() output. A file that fails is
 * logged as a ::warning:: and the others still load; throws only when every present file failed. A missing
 * V_DSS_WEIGHT_AND_CUBE.CSV is a plain log line (not published today); a missing one of the other four is a warning.
 */
export async function loadFreightPackaging(dir, files, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const total = { scanned: 0, kept: 0, written: 0 };
  for (const k of KINDS) {
    if (files.some((f) => f.kind === k.kind)) continue;
    if (k.optionalFile) log(`load.mjs: ${k.file} not found in ${dir} (not published in FREIGHT_PACKAGING.zip as of 2026-11), skipping`);
    else log(`::warning::load.mjs: ${k.file} not found in ${dir}, skipping`);
  }
  let failed = 0;
  let lastErr = null;
  const parts = {}; // packaging kind -> mapped rows, only for files that loaded
  const order = new Map(KINDS.map((k, i) => [k.kind, i]));
  for (const { file, kind } of [...files].sort((a, b) => order.get(a.kind) - order.get(b.kind))) {
    try {
      const res = await loadFreightPackagingFile(path.join(dir, file), kind, trackedByNiin, opts);
      total.scanned += res.scanned; total.kept += res.kept; total.written += res.written;
      if (res.rows) parts[kind] = res.rows;
    } catch (err) {
      failed += 1;
      lastErr = err;
      console.error(err);
      log(`::warning::load.mjs: ${file} load failed (${err.message}); continuing`);
    }
  }
  const loadedKinds = Object.keys(parts);
  if (loadedKinds.length > 0) {
    try {
      const { spec, rows, keyCounts } = buildPackagingWrite(parts);
      const w = makeWriter(spec);
      const add = dbGuard(w);
      for (const r of rows) await add(r);
      await w.flush();
      total.written += w.written;
      log(`load.mjs: pub.nsn_packaging merged write from ${loadedKinds.join(', ')}: ${rows.length} merged key(s) (rows from 1 file: ${keyCounts[1]}, 2 files: ${keyCounts[2]}, 3 files: ${keyCounts[3]}), ${w.written} written`);
    } catch (err) {
      failed += loadedKinds.length;
      lastErr = err;
      console.error(err);
      log(`::warning::load.mjs: pub.nsn_packaging write failed (${err.message}); continuing`);
    }
  } else if (files.some((f) => KINDS.find((k) => k.kind === f.kind).merged)) {
    log('::warning::load.mjs: no packaging file loaded; nothing written to pub.nsn_packaging');
  }
  if (files.length > 0 && failed >= files.length) throw lastErr;
  return total;
}
