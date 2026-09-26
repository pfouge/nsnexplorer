// shared/csv.mjs
// Small dependency-free CSV parser: quoted fields (RFC4180-ish), embedded
// commas, embedded newlines inside quotes, doubled-quote escaping ("").
// Used by /ingest/publog to read the PUB LOG bulk CSV exports.

/**
 * Parses a full CSV document into an array of arrays of strings (no header
 * handling — see parseCsvObjects for that).
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  let fieldStarted = false;

  const pushField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
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
      pushField();
      i += 1;
      continue;
    }

    if (c === '\r') {
      // Normalize CRLF and lone CR as row separators.
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }

    if (c === '\n') {
      pushRow();
      i += 1;
      continue;
    }

    field += c;
    fieldStarted = true;
    i += 1;
  }

  // Trailing field/row (files not ending in a newline).
  if (field !== '' || row.length > 0 || fieldStarted) {
    pushRow();
  }

  // Drop a single trailing wholly-empty row caused by a final newline.
  while (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ''
  ) {
    rows.pop();
  }

  return rows;
}

/**
 * Parses CSV text with a header row into an array of plain objects keyed by
 * header name, plus the raw header list. Header matching elsewhere should be
 * done case-insensitively by the caller (see findColumn).
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string,string>[] }}
 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...dataRows] = rows;
  const objects = dataRows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? r[idx] : '';
      });
      return obj;
    });
  return { headers, rows: objects };
}

/**
 * Case-insensitive header lookup with a helpful error when nothing matches.
 * `candidates` is a list of acceptable header names (any one match wins),
 * tried in order.
 *
 * @param {string[]} headers - actual headers found in the file
 * @param {string[]} candidates - acceptable header names, in priority order
 * @param {{ required?: boolean }} [opts]
 * @returns {string|null} the actual header string to use as a lookup key, or null
 */
export function findColumn(headers, candidates, opts = {}) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const cand of candidates) {
    const idx = lower.indexOf(cand.trim().toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  if (opts.required) {
    throw new Error(
      `findColumn: none of [${candidates.join(', ')}] found in headers. ` +
        `Headers present: [${headers.join(', ')}]`
    );
  }
  return null;
}
