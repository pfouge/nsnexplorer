// Pure, runtime-agnostic helpers and types shared by the build-time loader
// (data.ts, Node + pg) and the request-time NSN page loader (nsn-page.ts,
// Cloudflare Workers + postgres). Nothing here may import a Node-only module:
// this file is bundled into the Pages Function.

export const SITE_NAME = 'Government Parts Explorer';


export interface FscConfig {
  fsc: string;
  name: string;
  fsg: string;
  renderDepth: string;
}

export interface NsnRecord {
  nsn: string; // 13 digits
  niin: string; // 9 digits
  fsc: string;
  itemName: string | null;
  characteristics: unknown;
  hazmat: boolean | null;
  amc: string | null;
  amsc: string | null;
  amscObservedOn: string | null;
  amscSourceUrl: string | null;
}

export interface PricePointRecord {
  id: number;
  nsn: string;
  awardedOn: string; // ISO date (YYYY-MM-DD)
  unitPrice: number;
  quantity: number | null;
  totalValue: number | null;
  cage: string | null;
  supplierName: string | null;
  supplierCity: string | null;
  supplierState: string | null;
  agencyId: number | null;
  agencyName: string | null;
  agencyAbbr: string | null;
  solNumber: string | null;
  awardRef: string;
  source: string;
  sourceUrl: string;
  ingestedAt: string;
}

export interface ContractActionRecord {
  id: number;
  awardUid: string;
  piid: string | null;
  psc: string | null;
  naics: string | null;
  description: string | null;
  actionDate: string | null;
  obligation: number | null;
  agencyId: number | null;
  agencyName: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  sourceUrl: string;
  ingestedAt: string;
}

export interface AgencyRecord {
  agencyId: number;
  name: string;
  abbreviation: string | null;
  slug: string;
}

export interface PartNumberRecord {
  partNumber: string;
  cage: string | null;
  supplierName: string | null;
  source: string;
  sourceUrl: string;
}

/**
 * A currently-open (or otherwise-tracked) government solicitation from
 * pub.solicitations. Open demand spans the ENTIRE catalog — it is loaded
 * independent of the deep-FSC render-depth gate, which governs only the
 * historic priced catalog.
 */
export interface SolicitationRecord {
  solNumber: string;
  nsn: string | null;
  fsc: string | null;
  nomenclature: string | null;
  itemName: string | null;
  quantity: number | null;
  unitOfIssue: string | null;
  issuedOn: string | null; // ISO date (YYYY-MM-DD)
  returnBy: string | null; // ISO date (YYYY-MM-DD)
  status: string;
  setaside: string | null;
  buyerOffice: string | null;
  source: string;
  sourceUrl: string;
}

/** One FLIS characteristics entry as written by ingest/publog/load.mjs. */
export interface CharacteristicEntry {
  mrc: string | null;
  requirement: string | null;
  reply: string | null;
}

/**
 * Normalizes a pub.nsns.characteristics jsonb value (written by
 * ingest/publog/load.mjs as [{mrc, requirement, reply}]) into typed
 * entries, dropping anything malformed rather than rendering junk.
 */
export function parseCharacteristics(raw: unknown): CharacteristicEntry[] {
  if (!Array.isArray(raw)) return [];
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({ mrc: clean(e.mrc), requirement: clean(e.requirement), reply: clean(e.reply) }))
    .filter((e) => e.reply !== null || e.requirement !== null);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** '5331002915924' -> '5331-00-291-5924' */
export function toDashedNsn(nsn: string): string {
  return `${nsn.slice(0, 4)}-${nsn.slice(4, 6)}-${nsn.slice(6, 9)}-${nsn.slice(9, 13)}`;
}

/** '5331-00-291-5924' -> '5331002915924' */
export function undashNsn(dashed: string): string {
  return dashed.replace(/-/g, '');
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface PointWithSpike extends PricePointRecord {
  spikeRatio: number | null; // set when unit_price >= 3x trailing median
}

/**
 * Computes trailing-median spike ratios for a chronologically sorted list of
 * price points for one NSN. A point is a "spike" when its unit price is
 * >= 3x the median of all points up to and including itself.
 */
export function withSpikeRatios(points: PricePointRecord[]): PointWithSpike[] {
  const sorted = [...points].sort((a, b) => a.awardedOn.localeCompare(b.awardedOn));
  const out: PointWithSpike[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const trailing = sorted.slice(0, i + 1).map((p) => p.unitPrice);
    const trailingMedian = median(trailing);
    const ratio = trailingMedian > 0 ? sorted[i].unitPrice / trailingMedian : 0;
    out.push({ ...sorted[i], spikeRatio: ratio >= 3 ? ratio : null });
  }
  return out;
}

export interface NsnPriceStats {
  count: number;
  min: number;
  median: number;
  max: number;
  latest: number;
  swingPct: number; // (max-min)/min * 100
  latestVsMedianRatio: number;
  isOvercharge: boolean; // latest price >= 3x historical median
  totalSpend: number;
}

export function computeNsnPriceStats(points: PricePointRecord[]): NsnPriceStats | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.awardedOn.localeCompare(b.awardedOn));
  const prices = sorted.map((p) => p.unitPrice);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const med = median(prices);
  const latest = sorted[sorted.length - 1].unitPrice;
  const totalSpend = sorted.reduce(
    (sum, p) => sum + (p.totalValue ?? p.unitPrice * (p.quantity ?? 1)),
    0
  );
  return {
    count: sorted.length,
    min,
    median: med,
    max,
    latest,
    swingPct: min > 0 ? ((max - min) / min) * 100 : 0,
    latestVsMedianRatio: med > 0 ? latest / med : 0,
    isOvercharge: med > 0 && latest / med >= 3,
    totalSpend,
  };
}

export function assertSourceUrl(sourceUrl: unknown, context: string): string {
  if (typeof sourceUrl !== 'string' || sourceUrl.trim().length === 0) {
    throw new Error(
      `Data-honesty violation: renderable record with missing source_url (${context}). ` +
        `Build aborted per web-spec.md "Data honesty rules".`
    );
  }
  return sourceUrl;
}

/** Shared SELECT for pub.nsns + latest pub.amsc_observations, used for both
 * the deep-FSC catalog and the open-demand NSN metadata lookup below. Callers
 * append their own WHERE predicate and params. */
export const NSN_WITH_AMSC_SELECT = `
  SELECT n.nsn, n.niin, n.fsc, n.item_name, n.characteristics, n.hazmat,
         a.amc, a.amsc, a.observed_on AS amsc_observed_on, a.source_url AS amsc_source_url
  FROM pub.nsns n
  LEFT JOIN LATERAL (
    SELECT amc, amsc, observed_on, source_url
    FROM pub.amsc_observations ao
    WHERE ao.nsn = n.nsn
    ORDER BY observed_on DESC
    LIMIT 1
  ) a ON true
`;

export function mapNsnRow(r: {
  nsn: string;
  niin: string;
  fsc: string;
  item_name: string | null;
  characteristics: unknown;
  hazmat: boolean | null;
  amc: string | null;
  amsc: string | null;
  amsc_observed_on: string | Date | null;
  amsc_source_url: string | null;
}): NsnRecord {
  return {
    nsn: r.nsn,
    niin: r.niin,
    fsc: r.fsc,
    itemName: r.item_name,
    characteristics: r.characteristics,
    hazmat: r.hazmat,
    amc: r.amc,
    amsc: r.amsc,
    amscObservedOn: r.amsc_observed_on ? new Date(r.amsc_observed_on).toISOString().slice(0, 10) : null,
    amscSourceUrl: r.amsc_source_url,
  };
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function formatUsdPrecise(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

export function amscGloss(amsc: string | null): string | null {
  if (!amsc) return null;
  const table: Record<string, string> = {
    G: 'AMSC G — open competition: the government owns the data needed to make this part.',
    C: 'AMSC C — sole source: the government says it lacks the technical data to compete this part.',
    D: 'AMSC D — sole source: item requires source control or qualification.',
    H: 'AMSC H — sole source: acquisition restricted pending data rights review.',
    Z: 'AMSC Z — sole source: no competition action taken.',
  };
  return table[amsc] ?? `AMSC ${amsc}`;
}
