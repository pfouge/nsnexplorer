// Saved Open-demand searches (/open/ and /open/<fsc>/): turning the filter bar into a stored,
// normalized string and back. Pure, so the page script and the unit tests share it. The SQL
// mirror is search_sols() / search_key() / search_parse() in db/migrations/0009; keep the two in
// step (account.test.ts pins the string format).
//
// Which /open/<fsc>/ filters can be saved, and why:
//   Status        only "Open now": a saved search watches for new open solicitations, so
//                 "Closed" and "All" are not offered for saving.
//   Closing in    saved (3, 7 or 30 days): the card's earliest return-by within N days of today.
//   Min quantity  saved (100, 1000 or 10000): the card's summed open quantity, as on the page.
//   Competition   saved ("open" = Competed, "restricted" = Named source): the latest AMC / AMSC
//                 on record, the same rule as competitionOf() in shared.ts.
//   Has drawing   NOT saved. The page derives it from the NSN's characteristics in the browser
//                 build (diagram.ts); there is no column to match on, so a search with it set
//                 is not offered for saving.
//   Sort          not a filter, never saved.
// The class (FSC) comes from the page: /open/<fsc>/ saves that class; /open/ saves none.

export interface SearchFilters {
  fsc?: string | null;
  closes?: number | null;
  minqty?: number | null;
  comp?: 'open' | 'restricted' | null;
}

/** The normalized string: set filters only, in a fixed order; 'all' when none is set. */
export function searchKey(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.fsc) parts.push(`fsc=${f.fsc.toLowerCase()}`);
  if (f.closes) parts.push(`closes=${f.closes}`);
  if (f.minqty) parts.push(`minqty=${f.minqty}`);
  if (f.comp) parts.push(`comp=${f.comp}`);
  return parts.length ? parts.join(';') : 'all';
}

/** Parse a stored string; null when it is not one this site wrote. */
export function parseSearchKey(key: string): SearchFilters | null {
  if (key === 'all') return {};
  const out: SearchFilters = {};
  for (const part of key.split(';')) {
    const [k, v = ''] = part.split('=');
    if (k === 'fsc' && /^[a-z0-9]{4}$/i.test(v)) out.fsc = v.toUpperCase();
    else if (k === 'closes' && /^\d{1,3}$/.test(v) && Number(v) > 0) out.closes = Number(v);
    else if (k === 'minqty' && /^\d{1,9}$/.test(v) && Number(v) > 0) out.minqty = Number(v);
    else if (k === 'comp' && (v === 'open' || v === 'restricted')) out.comp = v;
    else return null;
  }
  return out;
}

const COMP_TEXT = { open: 'competed', restricted: 'named source' } as const;

/** Short label for a saved search, from the page's filters. `fscName` is the class name when known. */
export function searchLabel(f: SearchFilters, fscName?: string | null): string {
  const bits: string[] = [];
  if (f.closes) bits.push(`closing within ${f.closes} days`);
  if (f.minqty) bits.push(`quantity ${f.minqty.toLocaleString('en-US')}+`);
  if (f.comp) bits.push(COMP_TEXT[f.comp]);
  const where = f.fsc ? `${fscName ? `${fscName} ` : ''}(FSC ${f.fsc})` : 'all classes';
  return `Open demand: ${where}${bits.length ? `, ${bits.join(', ')}` : ''}`.slice(0, 200);
}

/** What the filter bar on /open/<fsc>/ holds, read from its controls (values as the controls use them). */
export interface FilterBar { status: string; closes: string; minqty: string; competition: string; hasDrawing: boolean }

/**
 * The filters to save, or a plain-text reason this bar cannot be saved. `fsc` is the page's class
 * (null on /open/).
 */
export function filtersFromBar(bar: FilterBar, fsc: string | null): { filters: SearchFilters } | { reason: string } {
  if (bar.status !== 'open') return { reason: 'Only open solicitations can be saved. Set Status to Open now.' };
  if (bar.hasDrawing) return { reason: 'A search with "Has drawing" cannot be saved, because the site has no record field to match it on. Clear that filter to save.' };
  const closes = bar.closes === 'any' ? null : Number(bar.closes);
  const minqty = bar.minqty === 'any' ? null : Number(bar.minqty);
  if ((closes !== null && !(closes > 0)) || (minqty !== null && !(minqty > 0))) return { reason: 'These filters cannot be saved.' };
  const comp = bar.competition === 'open' || bar.competition === 'restricted' ? bar.competition : null;
  return { filters: { fsc, closes, minqty, comp } };
}
