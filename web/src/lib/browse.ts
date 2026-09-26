// browse.ts — build-time helpers for the e-commerce-style browse framework
// (catalog -> department -> category -> product). Pure functions over the
// already-loaded SiteData; no I/O here.

import {
  parseCharacteristics,
  toDashedNsn,
  type CharacteristicEntry,
  type FscConfig,
  type NsnRecord,
  type SiteData,
  type SolicitationRecord,
} from './data';
import { buildThumbnail } from './diagram';

export interface ProductCard {
  nsn: string; // 13-digit undashed
  dashed: string; // 'FSC-NN-NNN-NNNN'
  fsc: string;
  itemName: string | null;
  thumbnail: string | null;
  lastPurchased: string | null; // ISO date
  purchaseRecords: number;
  perYear: number;
  totalDemand: number;
  competition: 'open' | 'restricted' | 'unknown';
  material: string | null;
  hasDrawing: boolean;
  latestPrice: number | null;
  /** Open-demand read from pub.solicitations (status = 'open'), for ANY FSC. */
  openNow: boolean;
  openCount: number;
  nextCloseDate: string | null; // ISO date, earliest return_by among open sols
  openQuantity: number | null; // sum of quantity across open sols; null if none open
  /** Count of solicitations for this NSN with status != 'open' (closed/expired/cancelled/awarded). */
  closedCount: number;
  /** Total solicitation count for this NSN, every status. */
  solicitationCount: number;
  /** Newest issued/return date across ALL solicitations for this NSN (ISO date), or null if none. */
  lastSolicited: string | null;
  /** Status of the most-recently-dated solicitation for this NSN. */
  lastStatus: 'open' | 'expired' | 'cancelled' | 'awarded' | 'unknown';
  /** True when this NSN is in pub.nsns and thus has a /nsn/[nsn]/ page
   * (rendered on request). False only for solicitations whose NSN is not in
   * the catalog, which link out to DIBBS instead. */
  hasCatalogPage: boolean;
  /** Where this card's links should point: the internal /nsn/ page when
   * hasCatalogPage is true, otherwise the official DIBBS record for the NSN. */
  href: string;
}

export interface DepartmentGroup {
  fsg: string;
  name: string;
  fscs: FscConfig[];
  nsnCount: number;
}

/**
 * Federal Supply Group (2-digit) display names — the official titles from
 * the DoD Federal Supply Classification (Cataloging Handbook H2), as
 * administered by DLA Logistics Information Service. Falls back to
 * "Group NN" for any code not listed here (there is no FSG 21/27/33/50/57/
 * 64/82/86/90/92/97/98 etc. — the ~78 codes below are the full valid set).
 *
 * Sourced/cross-checked against:
 *  - the H2 "Federal Supply Classification Groups and Classes" handbook text,
 *    as mirrored by two state-government archives:
 *    https://mn.gov/admin/assets/DISP_h2book[1]_tcm36-281917.pdf
 *    https://dps.mo.gov/dir/programs/ohs/documents/federal-supply-code-guide.pdf
 *  - https://www.nsnlookup.com/dla/federal-supply-group-fsg
 *  - https://www.turbogsa.com/resources/federal-supply-code/complete-fsc-product-codes/
 *
 * Five codes (15, 16, 17, 70, 84) have since been renamed by DLA from the
 * wording in the older H2 mirrors above (e.g. "Aircraft..." -> "Aerospace
 * Craft...", "Automatic Data Processing Equipment..." -> "Information
 * Technology Equipment...", "...and Insignia" -> "...Insignia, and
 * Jewelry"); the newer titles used below are corroborated by current SAM.gov
 * solicitation listings and multiple independent NSN-lookup sites
 * (nsnlookup.com, nsndepot.com, nsncenter.com, samsearch.co, parttarget.com).
 * These five are flagged here as lower-confidence than the rest — worth a
 * spot-check against DLA's live H2 search (https://public.logisticsinformationservice.dla.mil/H2/search.aspx)
 * if precision on them matters.
 */
export const FSG_NAMES: Record<string, string> = {
  '10': 'Weapons',
  '11': 'Nuclear Ordnance',
  '12': 'Fire Control Equipment',
  '13': 'Ammunition and Explosives',
  '14': 'Guided Missiles',
  '15': 'Aerospace Craft and Structural Components', // lower-confidence, see header comment
  '16': 'Aerospace Craft Components and Accessories', // lower-confidence, see header comment
  '17': 'Aerospace Craft Launching, Landing, Ground Handling, and Servicing Equipment', // lower-confidence, see header comment
  '18': 'Space Vehicles',
  '19': 'Ships, Small Craft, Pontoons, and Floating Docks',
  '20': 'Ship and Marine Equipment',
  '22': 'Railway Equipment',
  '23': 'Ground Effect Vehicles, Motor Vehicles, Trailers, and Cycles',
  '24': 'Tractors',
  '25': 'Vehicular Equipment Components',
  '26': 'Tires and Tubes',
  '28': 'Engines, Turbines, and Components',
  '29': 'Engine Accessories',
  '30': 'Mechanical Power Transmission Equipment',
  '31': 'Bearings',
  '32': 'Woodworking Machinery and Equipment',
  '34': 'Metalworking Machinery',
  '35': 'Service and Trade Equipment',
  '36': 'Special Industry Machinery',
  '37': 'Agricultural Machinery and Equipment',
  '38': 'Construction, Mining, Excavating, and Highway Maintenance Equipment',
  '39': 'Materials Handling Equipment',
  '40': 'Rope, Cable, Chain, and Fittings',
  '41': 'Refrigeration, Air Conditioning, and Air Circulating Equipment',
  '42': 'Fire Fighting, Rescue, and Safety Equipment; and Environmental Protection Equipment and Materials',
  '43': 'Pumps and Compressors',
  '44': 'Furnace, Steam Plant, and Drying Equipment; and Nuclear Reactors',
  '45': 'Plumbing, Heating, and Waste Disposal Equipment',
  '46': 'Water Purification and Sewage Treatment Equipment',
  '47': 'Pipe, Tubing, Hose, and Fittings',
  '48': 'Valves',
  '49': 'Maintenance and Repair Shop Equipment',
  '51': 'Hand Tools',
  '52': 'Measuring Tools',
  '53': 'Hardware and Abrasives',
  '54': 'Prefabricated Structures and Scaffolding',
  '55': 'Lumber, Millwork, Plywood, and Veneer',
  '56': 'Construction and Building Materials',
  '58': 'Communication, Detection, and Coherent Radiation Equipment',
  '59': 'Electrical and Electronic Equipment Components',
  '60': 'Fiber Optics Materials, Components, Assemblies, and Accessories',
  '61': 'Electric Wire, and Power and Distribution Equipment',
  '62': 'Lighting Fixtures and Lamps',
  '63': 'Alarm, Signal and Security Detection Systems',
  '65': 'Medical, Dental, and Veterinary Equipment and Supplies',
  '66': 'Instruments and Laboratory Equipment',
  '67': 'Photographic Equipment',
  '68': 'Chemicals and Chemical Products',
  '69': 'Training Aids and Devices',
  '70': 'Information Technology Equipment (Including Firmware), Software, Supplies and Support Equipment', // lower-confidence, see header comment
  '71': 'Furniture',
  '72': 'Household and Commercial Furnishings and Appliances',
  '73': 'Food Preparation and Serving Equipment',
  '74': 'Office Machines, Text Processing Systems and Visible Record Equipment',
  '75': 'Office Supplies and Devices',
  '76': 'Books, Maps, and Other Publications',
  '77': 'Musical Instruments, Phonographs, and Home-Type Radios',
  '78': 'Recreational and Athletic Equipment',
  '79': 'Cleaning Equipment and Supplies',
  '80': 'Brushes, Paints, Sealers, and Adhesives',
  '81': 'Containers, Packaging, and Packing Supplies',
  '83': 'Textiles, Leather, Furs, Apparel and Shoe Findings, Tents and Flags',
  '84': 'Clothing, Individual Equipment, Insignia, and Jewelry', // lower-confidence, see header comment
  '85': 'Toiletries',
  '87': 'Agricultural Supplies',
  '88': 'Live Animals',
  '89': 'Subsistence',
  '91': 'Fuels, Lubricants, Oils, and Waxes',
  '93': 'Nonmetallic Fabricated Materials',
  '94': 'Nonmetallic Crude Materials',
  '95': 'Metal Bars, Sheets, and Shapes',
  '96': 'Ores, Minerals, and Their Primary Products',
  '99': 'Miscellaneous',
};

export function fsgName(fsg: string): string {
  return FSG_NAMES[fsg] ?? `Group ${fsg}`;
}

/**
 * True when `name` is the ingest-time placeholder for an FSC whose real
 * title we don't have yet (see ingest/dibbs/load.mjs's `'FSC ' || fsc`
 * upsert), rather than a curated/real category title. Pages use this to
 * avoid rendering redundant headings like "FSC 7310 (FSC 7310)" — showing
 * the code once instead of pairing the placeholder with itself.
 */
export function isPlaceholderFscName(fsc: string, name: string | null | undefined): boolean {
  return !name || name === `FSC ${fsc}`;
}

/** Shown in place of a category title when the code is not in the FSC/PSC
 * handbook (ingest/reference/fsc-names.json), so a code never appears
 * without a description. */
export const UNLISTED_FSC_NAME = 'Unlisted supply class';

/** Category title for display: the curated name, or the unlisted label. */
export function fscDisplayName(fsc: string, name: string | null | undefined): string {
  return isPlaceholderFscName(fsc, name) ? UNLISTED_FSC_NAME : (name as string);
}

function extractMaterial(entries: CharacteristicEntry[]): string | null {
  const e = entries.find(
    (x) =>
      x.mrc === 'MATT' ||
      (x.requirement && /^MATERIAL$/i.test(x.requirement)) ||
      (x.requirement && /MATERIAL DOCUMENT/i.test(x.requirement)) ||
      (x.requirement && /MATERIAL/i.test(x.requirement))
  );
  return e?.reply ?? null;
}

/** Shared AMC/AMSC -> competition read, used by both the deep catalog cards
 * and the open-demand cards (which may fall outside the deep-FSC gate). */
function competitionFromAmscAmc(
  nsn: Pick<NsnRecord, 'amsc' | 'amc'> | undefined
): ProductCard['competition'] {
  if (!nsn) return 'unknown';
  return nsn.amsc === 'G' || nsn.amsc === 'Z' || nsn.amc === '1' || nsn.amc === '2'
    ? 'open'
    : nsn.amsc || nsn.amc
      ? 'restricted'
      : 'unknown';
}

/** Combines priced purchases (price_points) and NSN-attached contract
 * actions (contract_actions) into a single "last purchased / records per
 * year / total demand" read. Shared by buildProductCards and buildSolicitationCards. */
function computeDemandStats(
  data: SiteData,
  nsn: string
): { lastPurchased: string | null; purchaseRecords: number; perYear: number; totalDemand: number } {
  const rawPoints = data.pricePointsByNsn.get(nsn) ?? [];
  const contractActions = data.contractActionsByNsn.get(nsn) ?? [];

  const allDates = [
    ...rawPoints.map((p) => p.awardedOn),
    ...contractActions.map((c) => c.actionDate).filter((d): d is string => d !== null),
  ].sort();
  const lastPurchased = allDates.at(-1) ?? null;
  const firstPurchased = allDates[0] ?? null;
  const recordCount = rawPoints.length + contractActions.length;
  const spanYears =
    firstPurchased && lastPurchased
      ? Math.max(1, (new Date(lastPurchased).getTime() - new Date(firstPurchased).getTime()) / 31557600000)
      : 1;
  const perYear = recordCount / spanYears;
  const totalDemand =
    rawPoints.reduce((s, p) => s + (p.totalValue ?? p.unitPrice * (p.quantity ?? 1)), 0) +
    contractActions.reduce((s, c) => s + (c.obligation ?? 0), 0);

  return { lastPurchased, purchaseRecords: recordCount, perYear, totalDemand };
}

/**
 * Solicitation-history read for one NSN, computed from ALL of its
 * solicitations (every status — data.solicitationsByNsn is no longer
 * open-only). Splits into the open subset (count, soonest-closing date,
 * summed quantity) and the closed subset (count), plus a whole-history
 * summary (total count, newest date, status of the newest one).
 */
function computeSolicitationFields(sols: SolicitationRecord[]): {
  openNow: boolean;
  openCount: number;
  nextCloseDate: string | null;
  openQuantity: number | null;
  closedCount: number;
  solicitationCount: number;
  lastSolicited: string | null;
  lastStatus: ProductCard['lastStatus'];
} {
  const openSols = sols.filter((s) => s.status === 'open');
  const openCount = openSols.length;
  const closedCount = sols.length - openCount;
  const returnBys = openSols
    .map((s) => s.returnBy)
    .filter((d): d is string => d !== null)
    .sort();
  const nextCloseDate = returnBys[0] ?? null;
  const openQuantity = openCount > 0 ? openSols.reduce((s, x) => s + (x.quantity ?? 0), 0) : null;

  // Newest solicitation across the whole history, by return_by falling back
  // to issued_on — same ordering rule data.ts uses for solicitationsByNsn.
  const byRecency = [...sols].sort((a, b) => {
    const ad = a.returnBy ?? a.issuedOn ?? '';
    const bd = b.returnBy ?? b.issuedOn ?? '';
    return bd.localeCompare(ad);
  });
  const newest = byRecency[0];
  const lastSolicited = newest ? (newest.returnBy ?? newest.issuedOn ?? null) : null;
  const lastStatus = (newest?.status as ProductCard['lastStatus']) ?? 'unknown';

  return {
    openNow: openCount > 0,
    openCount,
    nextCloseDate,
    openQuantity,
    closedCount,
    solicitationCount: sols.length,
    lastSolicited,
    lastStatus,
  };
}

/**
 * Builds one product card per NSN in the given FSC, mirroring the
 * verdict-strip logic on the NSN detail page: combine priced purchases
 * (price_points) and NSN-attached contract actions (contract_actions) into
 * a single "last purchased / records per year / total demand" read.
 */
export function buildProductCards(data: SiteData, fsc: FscConfig): ProductCard[] {
  const nsns = data.nsnsByFsc.get(fsc.fsc) ?? [];

  const cards: ProductCard[] = nsns.map((nsn) => {
    const { lastPurchased, purchaseRecords, perYear, totalDemand } = computeDemandStats(data, nsn.nsn);
    const competition = competitionFromAmscAmc(nsn);

    const characteristics = parseCharacteristics(nsn.characteristics);
    const thumbnail = buildThumbnail(characteristics, fsc.fsc, nsn.itemName);
    const material = extractMaterial(characteristics);

    const sols = data.solicitationsByNsn.get(nsn.nsn) ?? [];
    const {
      openNow,
      openCount,
      nextCloseDate,
      openQuantity,
      closedCount,
      solicitationCount,
      lastSolicited,
      lastStatus,
    } = computeSolicitationFields(sols);
    const dashed = toDashedNsn(nsn.nsn);

    return {
      nsn: nsn.nsn,
      dashed,
      fsc: fsc.fsc,
      itemName: nsn.itemName,
      thumbnail,
      lastPurchased,
      purchaseRecords,
      perYear,
      totalDemand,
      competition,
      material,
      hasDrawing: thumbnail !== null,
      latestPrice: null,
      openNow,
      openCount,
      nextCloseDate,
      openQuantity,
      closedCount,
      solicitationCount,
      lastSolicited,
      lastStatus,
      hasCatalogPage: true,
      href: `/nsn/${dashed}/`,
    };
  });

  // Sensible default order for no-JS / first paint: most recently
  // purchased first, ties broken by demand. The client-side sort control
  // can reorder from here.
  return cards.sort((a, b) => {
    const dateCmp = (b.lastPurchased ?? '').localeCompare(a.lastPurchased ?? '');
    if (dateCmp !== 0) return dateCmp;
    return b.totalDemand - a.totalDemand;
  });
}

/** Groups the site's deep FSCs into Federal Supply Groups (departments). */
export function buildDepartments(data: SiteData): DepartmentGroup[] {
  const byFsg = new Map<string, FscConfig[]>();
  for (const fsc of data.deepFscs) {
    if (!byFsg.has(fsc.fsg)) byFsg.set(fsc.fsg, []);
    byFsg.get(fsc.fsg)!.push(fsc);
  }

  const groups: DepartmentGroup[] = [...byFsg.entries()].map(([fsg, fscs]) => {
    const nsnCount = fscs.reduce((sum, f) => sum + (data.nsnsByFsc.get(f.fsc)?.length ?? 0), 0);
    return {
      fsg,
      name: fsgName(fsg),
      fscs: [...fscs].sort((a, b) => a.fsc.localeCompare(b.fsc)),
      nsnCount,
    };
  });

  return groups.sort((a, b) => a.fsg.localeCompare(b.fsg));
}

/**
 * Builds one product card per NSN that has ANY solicitation on record —
 * open now, or closed (expired/cancelled/awarded) and kept as history —
 * spanning the entire catalog (not gated by render_depth='deep'). Pass `fsc`
 * to restrict to one Federal Supply Class (via data.solicitationsByFsc, all
 * statuses). Catalog metadata comes from data.openNsnByNsn (loaded for every
 * NSN with a solicitation, regardless of FSC depth), falling back to the
 * deep-catalog data.nsnByNsn when both are populated. Price/demand fields
 * reuse the same price_points + contract_actions joins as buildProductCards,
 * and default to 0/null when an NSN has no priced history yet.
 *
 * Sort: open cards (openCount > 0) first, closing-soonest first; then closed
 * cards, most-recently-solicited first. This keeps the page looking the same
 * as the old open-only board until a caller opts into the closed rows.
 */
export function buildSolicitationCards(data: SiteData, fsc?: string): ProductCard[] {
  const nsnCodes: string[] = fsc
    ? [
        ...new Set(
          (data.solicitationsByFsc.get(fsc)?.solicitations ?? [])
            .map((s) => s.nsn)
            .filter((n): n is string => n !== null)
        ),
      ]
    : [...data.solicitationsByNsn.keys()];

  const cards: ProductCard[] = nsnCodes.map((nsnCode) => {
    const sols = data.solicitationsByNsn.get(nsnCode) ?? [];
    const nsnMeta: NsnRecord | undefined = data.openNsnByNsn.get(nsnCode) ?? data.nsnByNsn.get(nsnCode);
    const cardFsc = nsnMeta?.fsc ?? sols.find((s) => s.fsc)?.fsc ?? fsc ?? '';
    const itemName =
      nsnMeta?.itemName ??
      sols.find((s) => s.itemName)?.itemName ??
      sols.find((s) => s.nomenclature)?.nomenclature ??
      null;

    const characteristics = nsnMeta ? parseCharacteristics(nsnMeta.characteristics) : [];
    const thumbnail = cardFsc ? buildThumbnail(characteristics, cardFsc, itemName) : null;
    const material = extractMaterial(characteristics);
    const competition = competitionFromAmscAmc(nsnMeta);

    const { lastPurchased, purchaseRecords, perYear, totalDemand } = computeDemandStats(data, nsnCode);
    const {
      openNow,
      openCount,
      nextCloseDate,
      openQuantity,
      closedCount,
      solicitationCount,
      lastSolicited,
      lastStatus,
    } = computeSolicitationFields(sols);
    const dashed = toDashedNsn(nsnCode);
    // Every NSN in pub.nsns has a page: /nsn/[nsn]/ is rendered on request
    // by the Pages Function (no build-time file budget), so open-demand cards
    // link internally whenever the NSN is in the catalog at all.
    const hasCatalogPage = data.nsnByNsn.has(nsnCode) || data.openNsnByNsn.has(nsnCode);
    const href = hasCatalogPage
      ? `/nsn/${dashed}/`
      : `https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=${nsnCode}&category=nsn`;

    return {
      nsn: nsnCode,
      dashed,
      fsc: cardFsc,
      itemName,
      thumbnail,
      lastPurchased,
      purchaseRecords,
      perYear,
      totalDemand,
      competition,
      material,
      hasDrawing: thumbnail !== null,
      latestPrice: null,
      openNow,
      openCount,
      nextCloseDate,
      openQuantity,
      closedCount,
      solicitationCount,
      lastSolicited,
      lastStatus,
      hasCatalogPage,
      href,
    };
  });

  // Open cards first (closing soonest first; unknown return_by sorts last
  // within the open group), then closed cards (most-recently-solicited
  // first; unknown date sorts last within the closed group).
  return cards.sort((a, b) => {
    const aOpen = a.openCount > 0;
    const bOpen = b.openCount > 0;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen && bOpen) {
      if (a.nextCloseDate === b.nextCloseDate) return 0;
      if (a.nextCloseDate === null) return 1;
      if (b.nextCloseDate === null) return -1;
      return a.nextCloseDate.localeCompare(b.nextCloseDate);
    }
    if (a.lastSolicited === b.lastSolicited) return 0;
    if (a.lastSolicited === null) return 1;
    if (b.lastSolicited === null) return -1;
    return b.lastSolicited.localeCompare(a.lastSolicited);
  });
}

/** Back-compat alias — buildOpenCards was renamed to buildSolicitationCards
 * when the card model grew to cover closed/historic solicitations too. */
export const buildOpenCards = buildSolicitationCards;

/**
 * Groups FSCs with open demand into Federal Supply Groups (departments),
 * mirroring buildDepartments but sourced from data.openByFsc so it spans
 * every FSC that currently has an open solicitation, not just deep ones.
 * nsnCount here counts open SOLICITATIONS in the group (per spec), not
 * distinct NSNs.
 */
export function buildOpenDepartments(data: SiteData): DepartmentGroup[] {
  const byFsg = new Map<
    string,
    { fsc: string; name: string | null; solicitations: SolicitationRecord[] }[]
  >();
  for (const entry of data.openByFsc.values()) {
    const fsg = entry.fsc.slice(0, 2);
    if (!byFsg.has(fsg)) byFsg.set(fsg, []);
    byFsg.get(fsg)!.push(entry);
  }

  const groups: DepartmentGroup[] = [...byFsg.entries()].map(([fsg, entries]) => {
    const nsnCount = entries.reduce((sum, e) => sum + e.solicitations.length, 0);
    const fscs: FscConfig[] = entries
      .map((e) => {
        const known = data.deepFscs.find((f) => f.fsc === e.fsc);
        if (known) return known;
        return { fsc: e.fsc, name: e.name ?? e.fsc, fsg, renderDepth: 'shallow' };
      })
      .sort((a, b) => a.fsc.localeCompare(b.fsc));
    return { fsg, name: fsgName(fsg), fscs, nsnCount };
  });

  return groups.sort((a, b) => a.fsg.localeCompare(b.fsg));
}
