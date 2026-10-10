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

/** Link text for a solicitation's source record, chosen from its source. */
export function solicitationLinkLabel(source: string | null | undefined): string {
  return source === 'sam_gov' ? 'View at SAM.gov →' : 'View at DIBBS →';
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

/* Acquisition method codes, as defined in DFARS PGI 217.7506 (spare parts
   breakout program). One table for the whole site: the part page, the class
   lists, the compare tool and the markdown twins all read from here. */
export type Competition = 'open' | 'restricted' | 'unknown';

export const AMC_MEANING: Record<string, string> = {
  '0': 'not established: the part has not completed screening',
  '1': 'suitable for competitive acquisition, second or later time',
  '2': 'suitable for competitive acquisition, first time',
  '3': 'buy directly from the actual manufacturer, second or later time',
  '4': 'buy directly from the actual manufacturer, first time',
  '5': 'buy from a sole-source contractor that is not the actual manufacturer',
};

export const AMSC_MEANING: Record<string, string> = {
  A: "the government's right to use the technical data it holds is in doubt",
  B: 'must be bought from the sources named on a source control or selected item drawing',
  C: 'needs engineering source approval; other sources must qualify first',
  D: 'the data needed to compete the part is unavailable or cannot be obtained economically',
  G: 'the government has a complete data package and the rights to use it',
  H: 'the government lacks sufficient, accurate or legible data to buy from other sources',
  K: 'must be made from class 1 castings or similar controlled forgings',
  L: 'annual buy value is below the screening threshold',
  M: 'making the part needs master or coordinated tooling',
  N: 'making the part needs special test or inspection facilities',
  O: 'no suffix code assigned: the part has not completed screening',
  P: 'the government does not own the rights to the data needed for more sources',
  Q: 'the government lacks adequate data or rights, but breakout to competition is expected',
  R: 'the government owns neither the data nor the rights, and obtaining them is judged uneconomical',
  S: 'restricted to government-approved sources because the item involves sensitive technology',
  T: 'handled under qualified products list procedures',
  U: 'the cost of breaking out and competing the part exceeds the projected savings',
  V: 'a high-reliability part in a formal reliability program',
  Y: 'the design is unstable and major changes are expected',
  Z: 'a commercial, nondevelopmental or off-the-shelf item',
};

/** AMC 1 or 2 is coded as suitable for competitive acquisition; AMC 3, 4 or 5
 *  is coded to a named source. With no usable AMC, only AMSC G (complete data
 *  and rights) says anything about competition. */
export function competitionOf(amc: string | null | undefined, amsc: string | null | undefined): Competition {
  if (amc === '1' || amc === '2') return 'open';
  if (amc === '3' || amc === '4' || amc === '5') return 'restricted';
  return amsc === 'G' ? 'open' : 'unknown';
}

export const COMPETITION_BADGE: Record<Competition, string> = {
  open: 'Coded for competition',
  restricted: 'Coded for a named source',
  unknown: 'Not coded',
};

/** One factual sentence for the part page. Describes the code on record, never a solicitation. */
export function competitionSentence(amc: string | null | undefined, amsc: string | null | undefined): string {
  if (!amc && !amsc) return 'No acquisition method code is on record for this item.';
  switch (competitionOf(amc, amsc)) {
    case 'open':
      return amc === '1' || amc === '2'
        ? `This item is coded as suitable for competitive acquisition (AMC ${amc}).`
        : 'This item is coded AMSC G: the government has a complete data package and the rights to use it.';
    case 'restricted':
      return amc === '5'
        ? 'This item is coded to be bought from a sole-source contractor that is not the actual manufacturer (AMC 5).'
        : `This item is coded to be bought directly from the actual manufacturer (AMC ${amc}).`;
    default:
      return 'The codes on record do not say whether this item is competed or bought from a named source.';
  }
}

export function amcGloss(amc: string | null): string | null {
  if (!amc) return null;
  return AMC_MEANING[amc] ? `AMC ${amc}: ${AMC_MEANING[amc]}.` : `AMC ${amc}`;
}

export function amscGloss(amsc: string | null): string | null {
  if (!amsc) return null;
  return AMSC_MEANING[amsc] ? `AMSC ${amsc}: ${AMSC_MEANING[amsc]}.` : `AMSC ${amsc}`;
}
