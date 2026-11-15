// Shapes SQL rows into the JSON the API returns and the results page draws. Pure: no database, no DOM.
import { alsoCalledFor } from './item-search.ts';
import type { NameHit, NameSearchResult } from './item-search.ts';
import type { NameRow } from './item-search-sql.ts';

const toDashedNsn = (nsn: string): string => `${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9, 13)}`;

const iso = (v: string | Date | null): string | null => {
  if (v === null || v === undefined) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

export function shapeNameRows(query: string, rows: NameRow[], offset: number): NameSearchResult {
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  const results: NameHit[] = rows.map((r) => ({
    nsn: toDashedNsn(String(r.nsn).trim()),
    name: r.item_name ?? '',
    fsc: String(r.fsc).trim(),
    fscName: r.fsc_name ?? null,
    alsoCalled: alsoCalledFor(r.item_name, r.also_called),
    open: Number(r.open_n),
    lastAward: iso(r.last_award),
  }));
  return { ok: true, query, total, offset, results, more: offset + results.length < total };
}
