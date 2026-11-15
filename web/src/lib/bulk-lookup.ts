// bulk-lookup.ts — pure helpers for the /lookup/ bulk NSN tool: parse a pasted
// list into NSNs and NIINs, split it into request-sized chunks, and write the
// results as CSV. No DOM and no database here, so it runs in node:test and in
// the browser bundle alike.
import { csvCell, toCsv as writeCsv, type CsvCell } from './csv.ts';

export interface ParsedBulkInput {
  /** 13-digit NSNs, deduped, in input order. */
  nsns: string[];
  /** 9-digit NIINs, deduped, in input order. */
  niins: string[];
  /** Tokens that are neither an NSN nor a NIIN (deduped, as typed). */
  rejected: string[];
  /** True when more valid ids were pasted than `max` and the extra were dropped. */
  truncated: boolean;
}

export const BULK_MAX_INPUT = 500;
export const BULK_CHUNK_SIZE = 50;

// Newlines, commas, semicolons, tabs, or a run of two or more spaces. A single
// space or hyphen stays inside a token ("5340 01 396 7260", "5340-01-396-7260").
const SEPARATORS = /[\r\n,;\t]+| {2,}/;
const HEADER = /^(nsn|niin|nsns|niins)$/i;
const NUMERIC_ID = /^[\d -]+$/;

export function parseBulkInput(text: string, max = BULK_MAX_INPUT): ParsedBulkInput {
  const nsns: string[] = [];
  const niins: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const raw of String(text ?? '').split(SEPARATORS)) {
    const token = raw.trim();
    if (!token || HEADER.test(token)) continue;
    const digits = NUMERIC_ID.test(token) ? token.replace(/\D/g, '') : '';
    if (digits.length !== 13 && digits.length !== 9) {
      if (!rejected.includes(token)) rejected.push(token);
      continue;
    }
    if (seen.has(digits)) continue;
    if (nsns.length + niins.length >= max) {
      truncated = true;
      continue;
    }
    seen.add(digits);
    (digits.length === 13 ? nsns : niins).push(digits);
  }
  return { nsns, niins, rejected, truncated };
}

/** Splits items into consecutive arrays of at most `size` (size < 1 is treated as 1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * CSV for the bulk results: header row first, RFC 4180 quoting, and the
 * formula-injection guard (a cell starting with = + - @ gets a leading single
 * quote), all from csv.ts. The file starts with a UTF-8 BOM and rows end in CRLF.
 */
export function toCsv(rows: readonly (readonly CsvCell[])[], headers: readonly string[] = []): string {
  return writeCsv(headers, rows);
}

export { csvCell };
