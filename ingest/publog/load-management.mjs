// ingest/publog/load-management.mjs
// Loader for DLA's PUB LOG "management" files (MANAGEMENT.zip) -> pub.nsn_management (migration 0020):
//
//   V_FLIS_MANAGEMENT.CSV   -> source 'FLIS'
//   V_MGMT_ARMY.CSV         -> source 'ARMY'          (and V_MGMT_NAVY / AIR_FORCE / MARINE_CORPS / COAST_GUARD:
//                                                      the part after V_MGMT_ names the source)
//   V_FLIS_MANAGEMENT_FUTURE.CSV is NOT loaded (future-dated changes, not what applies today).
//
// LAYOUT STATUS: UNVERIFIED. DLA's "Management FOIA Layout" PDF could not be downloaded from the build
// sandbox (www.dla.mil is not on its network allowlist), so the column NAMES below are the data elements
// the layout is documented to carry (NIIN, effective date, MOE code, AAC, SOS, UI, unit price, QUP, CIIC,
// SLC, repairability code), each with a few plausible header spellings. Rules that keep a wrong guess from
// loading wrong data:
//   - columns are resolved by header name ONLY. There is no positional fallback for a column whose name
//     is not found (a guessed position could silently read another column); it is logged as 'absent'.
//   - a file with no header row is refused (no verified positions to read it by).
//   - the NIIN column and at least one of the value columns must resolve, else the file fails (a
//     ::warning:: from main(), the rest of the run continues).
//   - every non-blank column that is not mapped is kept in `extra` (column name -> text), so nothing the
//     file carries is lost while the layout is being confirmed.
//   - the first run logs the header line, the resolved mapping, the unmapped header names, value
//     distributions, price statistics and the first mapped rows, for checking by hand.
//
// Same rules as load-flis.mjs otherwise: enrich-only (NIINs not in pub.nsns are skipped), streamed line by
// line, batched single-statement upserts, never deletes, an unchanged row is not rewritten (a second run
// reports written = 0).

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { splitCsvLine, quickNiinTracked, NIIN_RE } from './load.mjs';
import {
  at, clean, distribution, fileDateOf, makeWriter, parseFlisDate, resolveColumns, scan, dbGuard,
} from './load-flis.mjs';

// ---------------------------------------------------------------------------
// Layout (names only; pos -1 = no verified position, see the header comment)
// ---------------------------------------------------------------------------

export const MGMT_LAYOUT = [
  // Real header names, from the DLA layout: NIIN, EFFECTIVE_DATE, MOE, AAC, SOS, SOSM, UI, UI_CONV_FAC,
  // UNIT_PRICE, QUP, CIIC, SLC, REP_REC_CODE, MGMT_CTL, REP_NET_PR, USC, ROW_OBS_DT. They are listed first.
  { key: 'niin', names: ['NIIN'], pos: 0 },
  { key: 'moe_cd', names: ['MOE_CD', 'MOE_CODE', 'MOE', 'SVC_CD', 'SERVICE_CD', 'SERVICE', 'SVC'], pos: -1 },
  { key: 'effective_date', names: ['EFF_DATE', 'EFFECTIVE_DATE', 'EFF_DT', 'DT_EFF', 'DT_EFFECTIVE', 'EFFECTIVE_DT', 'DT_EFCTV'], pos: -1 },
  { key: 'aac', names: ['AAC'], pos: -1 },
  { key: 'sos', names: ['SOS', 'SOURCE_OF_SUPPLY'], pos: -1 },
  { key: 'ui', names: ['UI', 'UNIT_OF_ISSUE', 'UOI'], pos: -1 },
  { key: 'unit_price', names: ['UNIT_PRICE', 'UI_PRICE', 'UP', 'PRICE', 'STD_UNIT_PRICE', 'UNIT_PRC', 'UNT_PRC'], pos: -1 },
  { key: 'qup', names: ['QUP', 'QTY_PER_UNIT_PACK', 'QTY_UNIT_PACK'], pos: -1 },
  { key: 'ciic', names: ['CIIC'], pos: -1 },
  { key: 'slc', names: ['SLC', 'SHELF_LIFE_CODE', 'SHELF_LIFE'], pos: -1 },
  { key: 'repairability', names: ['REP_REC_CODE', 'RC', 'REPAIRABILITY_CODE', 'REPAIRABILITY', 'RPR_CD', 'REPAIR_CD', 'RECOVERABILITY_CODE'], pos: -1 },
];
const VALUE_KEYS = ['aac', 'sos', 'ui', 'unit_price', 'qup', 'ciic', 'slc', 'repairability'];

/** Upsert spec: key (nsn, source, moe_cd). */
export const MGMT_UPSERT = {
  table: 'pub.nsn_management',
  key: ['nsn', 'source', 'moe_cd'],
  touch: 'updated_at = now()',
  cols: [['nsn', 'text'], ['source', 'text'], ['moe_cd', 'text'], ['effective_date', 'date'], ['aac', 'text'],
    ['sos', 'text'], ['ui', 'text'], ['unit_price', 'numeric'], ['unit_price_raw', 'text'], ['qup', 'text'],
    ['ciic', 'text'], ['slc', 'text'], ['repairability', 'text'], ['extra', 'jsonb'], ['source_file_date', 'date']],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Which file names are management files, and the `source` each one writes. V_FLIS_MANAGEMENT.CSV -> 'FLIS';
 * V_MGMT_<NAME>.CSV -> '<NAME>' (ARMY, NAVY, AIR_FORCE, MARINE_CORPS, COAST_GUARD, ...). Anything with FUTURE
 * in the name is ignored. Returns [{file, source}] sorted with FLIS first.
 */
export function findManagementFiles(filesOnDisk) {
  const out = [];
  for (const file of filesOnDisk) {
    // Layout (DLA "Management FOIA Layout", updated 5/27/2025): only V_FLIS_MANAGEMENT.CSV carries price, unit of
    // issue, shelf life and the other codes this loader maps, one row per NIIN and MOE. The V_MGMT_<SERVICE>.CSV
    // files hold service-specific fund and budget codes and are not loaded.
    const m = /^V_(FLIS_MANAGEMENT)\.CSV$/i.exec(file);
    if (!m) continue;
    const base = m[1].toUpperCase();
    if (base.includes('FUTURE')) continue;
    out.push({ file, source: base === 'FLIS_MANAGEMENT' ? 'FLIS' : base.slice('MGMT_'.length) });
  }
  return out.sort((a, b) => (a.source === 'FLIS' ? -1 : b.source === 'FLIS' ? 1 : a.source.localeCompare(b.source)));
}

/** Date text -> 'YYYY-MM-DD' or null. DD-MON-YY / DD-MON-YYYY / ISO (parseFlisDate), plus YYYYMMDD and M/D/YYYY. */
export function parseMgmtDate(raw, now = new Date()) {
  const t = (raw || '').trim();
  if (!t) return null;
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return parseFlisDate(`${m[1]}-${m[2]}-${m[3]}`, now);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return parseFlisDate(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, now);
  return parseFlisDate(t, now);
}

/**
 * Price text -> {value, raw, plain}. value is a canonical decimal string ('12.4' stays '12.4', '$1,200.50' becomes
 * '1200.50') or null for blank / not a plain non-negative decimal; raw is the trimmed text (null when blank);
 * plain is true when the text has no decimal point (so a layout that implies two decimals can be spotted in the
 * log). The amount is taken as written, in dollars: an implied-decimal layout is NOT assumed.
 */
export function parsePrice(rawText) {
  const raw = clean(rawText);
  if (raw === null) return { value: null, raw: null, plain: false };
  const t = raw.replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^\d{1,13}(\.\d{1,6})?$/.test(t)) return { value: null, raw, plain: false };
  return { value: t, raw, plain: !t.includes('.') };
}

/**
 * Resolves columns for MGMT_LAYOUT. Same as resolveColumns, except a column whose name is not found never falls
 * back to a guessed position: it is -1 / 'absent'. Returns the resolveColumns result plus `missing` (keys absent).
 */
export function resolveMgmtColumns(firstFields) {
  const res = resolveColumns(MGMT_LAYOUT, firstFields, 'niin');
  if (res.hasHeader) {
    for (const c of MGMT_LAYOUT) {
      if (c.pos === -1 && res.via[c.key] === 'position') { res.cols[c.key] = -1; res.via[c.key] = 'absent'; }
    }
  }
  return { ...res, missing: MGMT_LAYOUT.filter((c) => res.cols[c.key] === -1).map((c) => c.key) };
}

/**
 * Maps one data row. Returns null when the NIIN is not tracked or the row carries none of the value columns.
 * `headers` (the file's header names) is used to fill `extra` with every non-blank unmapped column.
 */
export function mapManagementRow(f, cols, trackedByNiin, source, fileDate, headers = null) {
  const niin = at(f, cols.niin).trim();
  const nsn = NIIN_RE.test(niin) ? trackedByNiin.get(niin) : undefined;
  if (!nsn) return null;
  const price = parsePrice(at(f, cols.unit_price));
  const r = {
    nsn,
    source,
    moe_cd: (clean(at(f, cols.moe_cd)) ?? '').toUpperCase(),
    effective_date: parseMgmtDate(at(f, cols.effective_date)),
    aac: clean(at(f, cols.aac)),
    sos: clean(at(f, cols.sos)),
    ui: clean(at(f, cols.ui)),
    unit_price: price.value,
    unit_price_raw: price.raw,
    qup: clean(at(f, cols.qup)),
    ciic: clean(at(f, cols.ciic)),
    slc: clean(at(f, cols.slc)),
    repairability: clean(at(f, cols.repairability)),
    extra: null,
    source_file_date: fileDate,
  };
  if (!VALUE_KEYS.some((k) => r[k] !== null) && r.unit_price_raw === null) return null;
  if (headers) {
    const used = new Set(Object.values(cols).filter((i) => i >= 0));
    const extra = {};
    headers.forEach((h, i) => {
      if (used.has(i)) return;
      const v = clean(at(f, i));
      if (v !== null && clean(h) !== null) extra[h.trim().toUpperCase()] = v;
    });
    if (Object.keys(extra).length > 0) r.extra = extra;
  }
  return r;
}

const median = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

/** Price statistics over kept rows, for the first-run log. */
export function priceStats(rows) {
  const s = { rows: rows.length, priced: 0, zero: 0, blank: 0, unparsable: 0, noDecimalPoint: 0, min: null, max: null, median: null };
  const vals = [];
  for (const r of rows) {
    if (r.unit_price_raw === null) { s.blank += 1; continue; }
    if (r.unit_price === null) { s.unparsable += 1; continue; }
    const v = Number(r.unit_price);
    if (v === 0) { s.zero += 1; continue; }
    s.priced += 1;
    vals.push(v);
    if (!r.unit_price.includes('.')) s.noDecimalPoint += 1;
  }
  if (vals.length > 0) { s.min = Math.min(...vals); s.max = Math.max(...vals); s.median = median(vals); }
  return s;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

const defLog = (m) => console.log(m);
const fatal = (msg) => Object.assign(new Error(msg), { isDb: true }); // isDb makes scan() abort instead of counting a bad row

/** One management CSV -> pub.nsn_management. Returns {scanned, kept, written, rows} (rows: a capped sample for stats). */
export async function loadManagementFile(filePath, source, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const label = `${path.basename(filePath)} (source ${source})`;
  const fileDate = await fileDateOf(filePath, opts.sourceFileDate);
  const w = makeWriter(MGMT_UPSERT);
  const add = dbGuard(w);
  const seenKeys = new Set();
  let dupKeys = 0;
  let kept = 0;
  const sample = [];
  const firstRows = [];
  let checked = false;
  const { scanned, bad } = await scan(filePath, label, MGMT_LAYOUT, 'niin', async (f, _cols, meta) => {
    if (!checked) {
      checked = true;
      if (meta.headers === null) throw fatal(`${label}: no header row; the layout is unverified, refusing to read it by position. First line: ${f.join(',').slice(0, 300)}`);
    }
    const r = mapManagementRow(f, meta.cols, trackedByNiin, source, fileDate, meta.headers);
    if (!r) return;
    kept += 1;
    const k = `${r.nsn}|${r.source}|${r.moe_cd}`;
    if (seenKeys.has(k)) dupKeys += 1; else seenKeys.add(k);
    sample.push({ ...r, extra: null }); // lite copy: only the stats read it
    if (firstRows.length < 3) firstRows.push(r);
    await add(r);
  }, {
    log,
    // The first-field shortcut is only valid when NIIN is column 0 of this file.
    prefilter: (l, meta) => (meta && meta.cols && meta.cols.niin === 0 ? quickNiinTracked(l, trackedByNiin) : null),
  });
  await w.flush();
  return { scanned, kept, written: w.written, bad, dupKeys, sample, firstRows };
}

/** First line of a (possibly multi-GB) file, reading at most 64 KB. */
export async function readHeadLine(filePath) {
  const chunks = [];
  for await (const c of createReadStream(filePath, { start: 0, end: 65535 })) { chunks.push(c); break; }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.split(/\r?\n/)[0];
}

/** Logs the header-derived facts of one finished file (distributions, price stats, first rows). */
function logFileSummary(label, res, log) {
  const rows = res.sample;
  log(`load.mjs: ${label}: ${res.scanned} rows scanned, ${res.kept} on tracked NIINs, ${res.bad} malformed row(s) skipped, ${res.dupKeys} repeated (nsn, source, moe_cd) key(s) collapsed to the last row, ${res.written} written`);
  for (const [name, key] of [['UI', 'ui'], ['SLC', 'slc'], ['SOS', 'sos'], ['AAC', 'aac'], ['CIIC', 'ciic'], ['repairability', 'repairability'], ['MOE', 'moe_cd']]) {
    log(`load.mjs: ${label} ${name} distribution (tracked rows): ${distribution(rows.map((r) => (key === 'moe_cd' && r[key] === '' ? null : r[key])))}`);
  }
  const ps = priceStats(rows);
  log(`load.mjs: ${label} unit price: ${JSON.stringify(ps)}`);
  if (ps.priced > 0 && ps.noDecimalPoint / ps.priced > 0.5) {
    log(`::warning::load.mjs: ${label}: ${ps.noDecimalPoint} of ${ps.priced} non-zero prices have no decimal point; if the layout implies two decimals the stored prices are 100 times too high. Check the header line and these rows before trusting the prices.`);
  }
  const years = rows.map((r) => (r.effective_date ? r.effective_date.slice(0, 4) : null));
  log(`load.mjs: ${label} effective date year distribution: ${distribution(years)}`);
  for (const r of res.firstRows) log(`load.mjs: ${label} sample mapped row: ${JSON.stringify(r)}`);
}

/**
 * Loads every management file of a directory listing. `files` is findManagementFiles() output. A file that
 * fails is logged as a ::warning:: and the others still load; the call throws only when every file failed.
 */
export async function loadManagement(dir, files, trackedByNiin, opts = {}) {
  const log = opts.log || defLog;
  const total = { scanned: 0, kept: 0, written: 0 };
  let failed = 0;
  let lastErr = null;
  for (const { file, source } of files) {
    const fp = path.join(dir, file);
    const label = `${file}`;
    try {
      const headLine = await readHeadLine(fp);
      log(`load.mjs: ${label} first line: ${headLine.slice(0, 1000)}`);
      if (headLine) {
        const res = resolveMgmtColumns(splitCsvLine(headLine));
        if (res.hasHeader) {
          const unmapped = splitCsvLine(headLine).filter((_, i) => !Object.values(res.cols).includes(i));
          log(`load.mjs: ${label} header names not mapped (kept in extra when non-blank): ${unmapped.join(', ') || '(none)'}`);
          if (res.missing.length > 0) log(`::warning::load.mjs: ${label}: columns not found by header name: ${res.missing.join(', ')}`);
        }
      }
      const res = await loadManagementFile(fp, source, trackedByNiin, opts);
      logFileSummary(label, res, log);
      total.scanned += res.scanned; total.kept += res.kept; total.written += res.written;
    } catch (err) {
      failed += 1;
      lastErr = err;
      console.error(err);
      log(`::warning::load.mjs: ${file} load failed (${err.message}); continuing`);
    }
  }
  if (files.length > 0 && failed === files.length) throw lastErr;
  return total;
}
