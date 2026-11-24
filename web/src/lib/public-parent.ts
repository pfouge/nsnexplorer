// Public parent companies (pub.public_companies / pub.supplier_parent, migration 0026).
// Facts come from the spotthemoney.com database: SEC revenue, recent 8-K filings and federal
// lobbying. The supplier -> parent map comes from reviewed name rules (pub.parent_rules).

export interface ParentEvent { filed: string; item: string; url: string }
export interface ParentSibling { cage: string; name: string; place: string | null; dollars12m: number }
export interface PublicParent {
  cik: string;
  ticker: string;
  name: string;
  revenue: number | null;
  revenuePeriodEnd: string | null;
  lobbying: number | null;
  lobbyingLabel: string | null;
  events: ParentEvent[];
  stmUrl: string | null;
  secUrl: string;
  asOf: string | null;
  siblings: number;
  siblingRows: ParentSibling[];
}

/** Plain words for the 8-K item a filing leads with (SEC Form 8-K item numbers). */
export const EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'Signed a material agreement',
  '1.02': 'Ended a material agreement',
  '2.01': 'Completed an acquisition or sale',
  '2.02': 'Reported quarterly results',
  '2.03': 'Took on new debt',
  '2.05': 'Announced restructuring costs',
  '2.06': 'Recorded an impairment',
  '3.01': 'Stock listing notice',
  '5.02': 'Changed directors or officers',
  '5.03': 'Changed its charter or bylaws',
  '5.07': 'Reported a shareholder vote',
  '5.08': 'Set a shareholder meeting date',
  '7.01': 'Issued an investor update',
  '8.01': 'Reported other news',
  '9.01': 'Filed exhibits',
};
export const eightKLabel = (item: string): string => EIGHT_K_ITEMS[item] ?? `Form 8-K item ${item}`;

/** One sub-select for the supplier page statement ($1 = CAGE). */
export const PARENT_SQL = `(SELECT jsonb_build_object(
    'cik', pc.cik, 'ticker', pc.ticker, 'name', pc.name, 'revenue', pc.revenue,
    'revenue_period_end', pc.revenue_period_end, 'lobbying', pc.lobbying_year,
    'lobbying_label', pc.lobbying_year_label, 'events', pc.events, 'stm_url', pc.stm_url, 'as_of', pc.as_of,
    'siblings', (SELECT count(*) FROM pub.supplier_parent x WHERE x.cik = pc.cik AND x.cage <> $1),
    'sibling_rows', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.d12 DESC, t.cage), '[]'::jsonb)
       FROM (SELECT x.cage, s.name, s.city, s.state, COALESCE(st.dollars_12m, 0) AS d12
             FROM pub.supplier_parent x
             JOIN pub.suppliers s ON s.cage = x.cage
             LEFT JOIN pub.supplier_stats st ON st.cage = x.cage
             WHERE x.cik = pc.cik AND x.cage <> $1 AND st.cage IS NOT NULL
             ORDER BY COALESCE(st.dollars_12m, 0) DESC, x.cage
             LIMIT 5) t))
   FROM pub.supplier_parent sp JOIN pub.public_companies pc ON pc.cik = sp.cik
   WHERE sp.cage = $1)`;

type J = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function mapParent(j: J | null): PublicParent | null {
  if (!j || !str(j.ticker)) return null;
  const cik = String(j.cik);
  return {
    cik,
    ticker: String(j.ticker),
    name: str(j.name) ?? String(j.ticker),
    revenue: n(j.revenue),
    revenuePeriodEnd: str(j.revenue_period_end),
    lobbying: n(j.lobbying),
    lobbyingLabel: str(j.lobbying_label),
    events: Array.isArray(j.events)
      ? (j.events as J[]).filter((e) => str(e.filed) && str(e.url)).map((e) => ({ filed: String(e.filed), item: String(e.item ?? ''), url: String(e.url) }))
      : [],
    stmUrl: str(j.stm_url),
    secUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=8-K`,
    asOf: str(j.as_of),
    siblings: Number(j.siblings ?? 0),
    siblingRows: Array.isArray(j.sibling_rows)
      ? (j.sibling_rows as J[]).map((r) => ({
          cage: String(r.cage),
          name: str(r.name) ?? String(r.cage),
          place: [str(r.city), str(r.state)].filter(Boolean).join(', ') || null,
          dollars12m: Number(r.d12 ?? 0),
        }))
      : [],
  };
}

/** "$88.6 billion" style, for revenue and lobbying. */
export function bigUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)} billion`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)} million`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)} thousand`;
  return `$${Math.round(v)}`;
}

/** "Map of CAGE -> parent" for supplier lists (one query, any number of codes). */
export const PARENTS_FOR_CAGES_SQL = `SELECT sp.cage, pc.ticker, pc.name
  FROM pub.supplier_parent sp JOIN pub.public_companies pc ON pc.cik = sp.cik
  WHERE sp.cage = ANY($1::text[])`;

export interface ParentMark { ticker: string; name: string }

/** Every value under a key named `cage` anywhere in a page object (part and solicitation pages). */
export function collectCages(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(obj)) { for (const v of obj) collectCages(v, out); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'cage' || k.endsWith('Cage')) { if (typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v.trim())) out.add(v.trim()); }
      else if (v && typeof v === 'object') collectCages(v, out);
    }
  }
  return out;
}

/** CAGE -> public parent for a set of codes. Never throws: a page renders without marks on error. */
export async function loadParentMarks(
  sql: { unsafe: (q: string, p?: unknown[]) => Promise<unknown> },
  cages: Iterable<string>,
): Promise<Map<string, ParentMark>> {
  const list = [...new Set(cages)].slice(0, 2000);
  const out = new Map<string, ParentMark>();
  if (list.length === 0) return out;
  try {
    const rows = (await sql.unsafe(PARENTS_FOR_CAGES_SQL, [list])) as Array<{ cage: string; ticker: string; name: string }>;
    for (const r of rows) out.set(String(r.cage).trim(), { ticker: r.ticker, name: r.name });
  } catch {
    /* tables missing or a transient error: no marks */
  }
  return out;
}
