// csv.ts — tiny CSV writer for the /data/*.csv downloads.
//
// - RFC 4180: fields containing a comma, double quote, CR or LF are wrapped in
//   double quotes with inner quotes doubled; rows end in CRLF.
// - Formula-injection guard: a text cell that starts with =, +, - or @ (or a
//   tab / carriage return, which some spreadsheets also treat as a formula
//   lead-in) gets a single quote in front so Excel, Sheets and LibreOffice
//   read it as text. A cell that is a plain number ("-12.5") is left alone,
//   and real JS numbers are written as numbers, so negative amounts survive.
// - A UTF-8 byte-order mark leads the file so Excel opens it as UTF-8.

export type CsvCell = string | number | null | undefined;

export const CSV_BOM = '﻿';

const PLAIN_NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    text = String(value);
  } else {
    text = value;
    if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

/** Response for a prerendered CSV endpoint: UTF-8 text, saved as a file. */
export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
