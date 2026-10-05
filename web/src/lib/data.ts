// Build-time data loader. Reads pub.* from Postgres via DATABASE_URL.
// This module is the ONLY place the web layer talks to the database.
//
// Hard requirement (web-spec.md "Data honesty rules"): the build MUST fail if
// any price_point selected for rendering has a null/empty source_url. The
// database schema already enforces NOT NULL, but we re-check here so the
// build fails loudly and specifically if that invariant is ever violated
// (e.g. by an empty-string source_url, which NOT NULL does not catch).

import type pgTypes from 'pg';
import { buildThumbnail } from './diagram';
import {
  type FscConfig, type NsnRecord, type PricePointRecord, type ContractActionRecord,
  type AgencyRecord, type PartNumberRecord, type SolicitationRecord,
  parseCharacteristics, slugify, assertSourceUrl, NSN_WITH_AMSC_SELECT, mapNsnRow, toDashedNsn,
} from './shared';
import { compareByClosing, mapServiceNotice, type ServiceNotice, type ServiceNoticeRow } from './services';
import { nomen } from './seo-copy';
import { foldCalendarRows } from './viz-open';
import type { DailyStatRow, FreshnessSource, GroupDemandRow, TapeItem, TileInput } from './viz-site';
import type { RepeatRow, StateCount, WeekCount, WinnerRow } from './viz-class';

export * from './shared';
export type { ServiceNotice } from './services';

// `pg` is loaded lazily so this module can sit in the same bundle chunk as
// the pure helpers without dragging a Node-only driver into the Cloudflare
// Pages Function (which renders /nsn/* and /api/* at request time and never
// calls fetchSiteData).
async function openPool(): Promise<pgTypes.Pool> {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL) });
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://root@127.0.0.1:5432/gpx';

// Hosted Postgres (Supabase Session pooler, port 5432, used by the GitHub
// Actions build) requires TLS; the local dev database does not offer it.
function sslFor(connectionString: string): { rejectUnauthorized: false } | undefined {
  const host = new URL(connectionString).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return local ? undefined : { rejectUnauthorized: false };
}

/** Per-class aggregates for the "Market view" charts, computed once in SQL. */
export interface ClassViz {
  repeat: RepeatRow[];
  weekly: WeekCount[];
  winners: { top: WinnerRow[]; suppliers: number; total: number } | null;
  states: StateCount[];
}

/**
 * Aggregates behind the charts, one grouped SQL query per feature (see
 * loadVizData). `today` is the database's CURRENT_DATE so every "N days from
 * now" on a page agrees with the SQL that selected the rows.
 */
export interface SiteViz {
  today: string;
  /** earliest issued_on of any solicitation on record, ISO, or null */
  earliestSolicitation: string | null;
  tape: TapeItem[];
  freshness: FreshnessSource[];
  tiles: TileInput;
  dailyStats: DailyStatRow[];
  groups: GroupDemandRow[];
  /** 30 daily counts of open product solicitations by return_by, per class and for all ('*') */
  closing: Map<string, number[]>;
  byClass: Map<string, ClassViz>;
}

export interface SiteData {
  viz: SiteViz;
  deepFscs: FscConfig[];
  nsns: NsnRecord[];
  nsnByNsn: Map<string, NsnRecord>;
  nsnsByFsc: Map<string, NsnRecord[]>;
  partNumbersByNsn: Map<string, PartNumberRecord[]>;
  pricePointsByNsn: Map<string, PricePointRecord[]>;
  contractActionsByNsn: Map<string, ContractActionRecord[]>;
  contractActionsByFsc: Map<string, ContractActionRecord[]>;
  agencies: AgencyRecord[];
  purchasesByAgency: Map<number, (PricePointRecord & { nsn: string; itemName: string | null })[]>;
  /**
   * ALL solicitations (every status), keyed by NSN, newest first
   * (COALESCE(return_by, issued_on) DESC). Spans ALL FSCs, not just deep
   * ones. This is the per-NSN demand record — open AND closed.
   */
  solicitationsByNsn: Map<string, SolicitationRecord[]>;
  /** Flat list of all open solicitations (status = 'open'), closing-soonest first. */
  openSolicitations: SolicitationRecord[];
  /** Open-only solicitations grouped by FSC, for open-count reads. */
  openByFsc: Map<string, { fsc: string; name: string | null; solicitations: SolicitationRecord[] }>;
  /**
   * ALL solicitations (every status) grouped by FSC, newest first — the
   * history browse that powers /open/[fsc]/'s "Closed" and "All" filters.
   */
  solicitationsByFsc: Map<string, { fsc: string; name: string | null; solicitations: SolicitationRecord[] }>;
  /** Distinct, non-null NSN codes that have at least one open solicitation. */
  openNsnCodes: string[];
  /**
   * Catalog metadata (item name, characteristics, AMC/AMSC) for every NSN
   * that has ANY solicitation on record (open or closed), even when it sits
   * outside the deep-FSC gate (nsnByNsn only covers deep FSCs). Lets
   * solicitation cards render a thumbnail/material/competition read even
   * when the NSN's FSC isn't rendered deep. Superset of the old "open NSNs
   * only" set — the name is kept for API stability.
   */
  openNsnByNsn: Map<string, NsnRecord>;
  /**
   * Open SAM.gov SERVICE notices (letter-coded PSC, or no code), closing
   * soonest first. Separate from the parts lane above, which drops letter
   * codes on purpose; this feeds /services/.
   */
  serviceNotices: ServiceNotice[];
  /** Keyed by category letter ('J'); 'other' = no usable code. */
  serviceNoticesByCategory: Map<string, ServiceNotice[]>;
  /** Keyed by 2-digit supply group, equipment-service notices only. */
  serviceNoticesByFsg: Map<string, ServiceNotice[]>;
  stats: {
    totalNsns: number;
    totalPurchases: number;   // rows in pub.price_points (real unit prices)
    totalDollars: number;     // dollars across those priced purchases
    totalActions: number;     // indexed contract actions (obligation totals)
    totalObligated: number;   // dollars across those actions
    openSolicitationsCount: number; // rows in pub.solicitations with status = 'open'
    openClosingSoon: number;        // open solicitations with return_by within 7 days
    openTotalQuantity: number;      // sum of quantity across open solicitations
    totalSolicitations: number;     // ALL rows in pub.solicitations, every status
    closedSolicitationsCount: number; // rows in pub.solicitations with status != 'open'
  };
}

let cachedNsnCodes: Promise<string[]> | null = null;

/**
 * Every 13-digit NSN the on-demand /nsn/ route will serve whose class is not
 * excluded, ordered by NSN. Kept out of SiteData on purpose (80k+ strings the
 * other pages never need); only the NSN sitemap files read it.
 */
export function loadNsnSitemapCodes(): Promise<string[]> {
  if (!cachedNsnCodes) {
    cachedNsnCodes = (async () => {
      const pool = await openPool();
      try {
        const res = await pool.query<{ nsn: string }>(
          `SELECT n.nsn FROM pub.nsns n JOIN pub.fsc f ON f.fsc = n.fsc
           WHERE f.render_depth <> 'excluded' ORDER BY n.nsn`
        );
        return res.rows.map((r) => r.nsn);
      } finally {
        await pool.end();
      }
    })();
  }
  return cachedNsnCodes;
}

let cached: Promise<SiteData> | null = null;

export function loadSiteData(): Promise<SiteData> {
  if (!cached) cached = fetchSiteData();
  return cached;
}

async function fetchSiteData(): Promise<SiteData> {
  const pool = await openPool();
  try {
    const fscRes = await pool.query<{ fsc: string; name: string; fsg: string; render_depth: string }>(
      // Every non-excluded category (migration 0005 retired the deep/shallow
      // gate; the name deepFscs is kept for API stability).
      `SELECT fsc, name, fsg, render_depth FROM pub.fsc WHERE render_depth <> 'excluded' AND fsc ~ '^[0-9]{4}$' ORDER BY fsc`
    );
    const deepFscs: FscConfig[] = fscRes.rows.map((r) => ({
      fsc: r.fsc,
      name: r.name,
      fsg: r.fsg,
      renderDepth: r.render_depth,
    }));
    const fscCodes = deepFscs.map((f) => f.fsc);

    const nsnByNsn = new Map<string, NsnRecord>();
    const nsnsByFsc = new Map<string, NsnRecord[]>();
    for (const f of deepFscs) nsnsByFsc.set(f.fsc, []);

    if (fscCodes.length > 0) {
      const nsnRes = await pool.query(
        `${NSN_WITH_AMSC_SELECT} WHERE n.fsc = ANY($1) ORDER BY n.nsn`,
        [fscCodes]
      );
      for (const r of nsnRes.rows) {
        const rec = mapNsnRow(r);
        nsnByNsn.set(rec.nsn, rec);
        const list = nsnsByFsc.get(rec.fsc);
        if (list) list.push(rec);
      }
    }
    const nsns = [...nsnByNsn.values()];
    const nsnCodes = nsns.map((n) => n.nsn);

    // Manufacturer part-number cross-references (FLIS / PUB LOG), with the
    // supplier name when the CAGE is known.
    const partNumbersByNsn = new Map<string, PartNumberRecord[]>();
    if (nsnCodes.length > 0) {
      const pnRes = await pool.query(
        `SELECT pn.nsn, pn.part_number, pn.cage, pn.source, pn.source_url, s.name AS supplier_name
         FROM pub.part_numbers pn
         LEFT JOIN pub.suppliers s ON s.cage = pn.cage
         WHERE pn.nsn = ANY($1)
         ORDER BY pn.part_number`,
        [nsnCodes]
      );
      for (const r of pnRes.rows) {
        const rec: PartNumberRecord = {
          partNumber: r.part_number,
          cage: r.cage,
          supplierName: r.supplier_name,
          source: r.source,
          sourceUrl: assertSourceUrl(r.source_url, `part_numbers ${r.nsn}/${r.part_number}`),
        };
        if (!partNumbersByNsn.has(r.nsn)) partNumbersByNsn.set(r.nsn, []);
        partNumbersByNsn.get(r.nsn)!.push(rec);
      }
    }

    const pricePointsByNsn = new Map<string, PricePointRecord[]>();
    let totalPurchases = 0;
    let totalDollars = 0;
    const agencyMap = new Map<number, AgencyRecord>();
    const purchasesByAgency = new Map<
      number,
      (PricePointRecord & { nsn: string; itemName: string | null })[]
    >();

    if (nsnCodes.length > 0) {
      const ppRes = await pool.query(
        `SELECT pp.id, pp.nsn, pp.awarded_on, pp.unit_price, pp.quantity, pp.total_value,
                pp.cage, s.name AS supplier_name, s.city AS supplier_city, s.state AS supplier_state,
                pp.agency_id, ag.name AS agency_name, ag.abbreviation AS agency_abbr,
                pp.sol_number, pp.award_ref, pp.source, pp.source_url, pp.ingested_at
         FROM pub.price_points pp
         LEFT JOIN pub.suppliers s ON s.cage = pp.cage
         LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
         WHERE pp.nsn = ANY($1)
         ORDER BY pp.nsn, pp.awarded_on`,
        [nsnCodes]
      );
      for (const r of ppRes.rows) {
        const sourceUrl = assertSourceUrl(
          r.source_url,
          `price_points.id=${r.id} nsn=${r.nsn}`
        );
        const rec: PricePointRecord = {
          id: Number(r.id),
          nsn: r.nsn,
          awardedOn: new Date(r.awarded_on).toISOString().slice(0, 10),
          unitPrice: Number(r.unit_price),
          quantity: r.quantity !== null ? Number(r.quantity) : null,
          totalValue: r.total_value !== null ? Number(r.total_value) : null,
          cage: r.cage,
          supplierName: r.supplier_name,
          supplierCity: r.supplier_city,
          supplierState: r.supplier_state,
          agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
          agencyName: r.agency_name,
          agencyAbbr: r.agency_abbr,
          solNumber: r.sol_number,
          awardRef: r.award_ref,
          source: r.source,
          sourceUrl,
          ingestedAt: new Date(r.ingested_at).toISOString(),
        };
        if (!pricePointsByNsn.has(rec.nsn)) pricePointsByNsn.set(rec.nsn, []);
        pricePointsByNsn.get(rec.nsn)!.push(rec);
        totalPurchases += 1;
        totalDollars += rec.totalValue ?? rec.unitPrice * (rec.quantity ?? 1);

        if (rec.agencyId !== null) {
          if (!agencyMap.has(rec.agencyId)) {
            agencyMap.set(rec.agencyId, {
              agencyId: rec.agencyId,
              name: rec.agencyName ?? `Agency ${rec.agencyId}`,
              abbreviation: rec.agencyAbbr,
              slug: slugify(rec.agencyName ?? `agency-${rec.agencyId}`),
            });
          }
          if (!purchasesByAgency.has(rec.agencyId)) purchasesByAgency.set(rec.agencyId, []);
          const nsnRecord = nsnByNsn.get(rec.nsn);
          purchasesByAgency
            .get(rec.agencyId)!
            .push({ ...rec, nsn: rec.nsn, itemName: nsnRecord?.itemName ?? null });
        }
      }
    }

    const contractActionsByNsn = new Map<string, ContractActionRecord[]>();
    const contractActionsByFsc = new Map<string, ContractActionRecord[]>();
    let totalActions = 0;
    let totalObligated = 0;
    if (nsnCodes.length > 0 || fscCodes.length > 0) {
      const caRes = await pool.query(
        `SELECT ca.id, ca.award_uid, ca.piid, ca.psc, ca.naics, ca.description, ca.action_date,
                ca.obligation, ca.agency_id, ag.name AS agency_name, ca.recipient_name,
                ca.recipient_uei, ca.source_url, ca.raw, ca.ingested_at
         FROM pub.contract_actions ca
         LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
         WHERE (ca.raw ->> 'nsn') = ANY($1) OR ca.psc = ANY($2)`,
        [nsnCodes.length > 0 ? nsnCodes : [''], fscCodes.length > 0 ? fscCodes : ['']]
      );
      for (const r of caRes.rows) {
        const rec: ContractActionRecord = {
          id: Number(r.id),
          awardUid: r.award_uid,
          piid: r.piid,
          psc: r.psc,
          naics: r.naics,
          description: r.description,
          actionDate: r.action_date ? new Date(r.action_date).toISOString().slice(0, 10) : null,
          obligation: r.obligation !== null ? Number(r.obligation) : null,
          agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
          agencyName: r.agency_name,
          recipientName: r.recipient_name,
          recipientUei: r.recipient_uei,
          sourceUrl: assertSourceUrl(r.source_url, `contract_actions.id=${r.id}`),
          ingestedAt: new Date(r.ingested_at).toISOString(),
        };
        totalActions += 1;
        totalObligated += rec.obligation ?? 0;
        const rawNsn: string | undefined = r.raw?.nsn;
        if (rawNsn && nsnByNsn.has(rawNsn)) {
          if (!contractActionsByNsn.has(rawNsn)) contractActionsByNsn.set(rawNsn, []);
          contractActionsByNsn.get(rawNsn)!.push(rec);
        } else if (rec.psc && nsnsByFsc.has(rec.psc)) {
          if (!contractActionsByFsc.has(rec.psc)) contractActionsByFsc.set(rec.psc, []);
          contractActionsByFsc.get(rec.psc)!.push(rec);
        }
      }
    }

    // Demand history board: ALL solicitations (every status) across the
    // ENTIRE catalog. NOT gated by render_depth='deep' — demand can land on
    // any FSC, including ones the historic priced catalog doesn't render.
    // Rows are never deleted; closed RFQs stick around as status
    // expired/cancelled/awarded, so this is a growing record of federal
    // demand, not just a live board.
    const solicitationsByNsn = new Map<string, SolicitationRecord[]>();
    const openByFsc = new Map<
      string,
      { fsc: string; name: string | null; solicitations: SolicitationRecord[] }
    >();
    const solicitationsByFsc = new Map<
      string,
      { fsc: string; name: string | null; solicitations: SolicitationRecord[] }
    >();
    const openNsnCodesSet = new Set<string>();
    const allSolNsnCodesSet = new Set<string>();
    let openClosingSoon = 0;
    let openTotalQuantity = 0;
    let closedSolicitationsCount = 0;
    const closingSoonCutoff = new Date();
    closingSoonCutoff.setUTCDate(closingSoonCutoff.getUTCDate() + 7);

    const solRes = await pool.query(
      // Open means open TODAY: a row still flagged 'open' whose return_by has
      // passed (i.e. NOT (return_by IS NULL OR return_by >= CURRENT_DATE)) is
      // reported as 'expired' so it is neither listed nor counted as open.
      `SELECT s.sol_number, s.nsn, s.fsc, f.name AS fsc_name, f.render_depth AS fsc_depth, s.nomenclature,
              s.quantity, s.unit_of_issue, s.issued_on, s.return_by,
              CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
              s.setaside, s.buyer_office, s.source, s.source_url, n.item_name
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       LEFT JOIN pub.fsc f ON f.fsc = s.fsc
       ORDER BY COALESCE(s.return_by, s.issued_on) DESC NULLS LAST, s.sol_number`
    );
    // Open lane excludes service PSCs: a non-null fsc must be a 4-digit class
    // and not 'excluded' in pub.fsc (same rule as the catalog query above).
    // Rows with a NULL fsc keep their existing treatment.
    const solRows = solRes.rows.filter(
      (r) => r.fsc === null || r.fsc === undefined || (/^[0-9]{4}$/.test(String(r.fsc)) && r.fsc_depth !== 'excluded')
    );
    const allSolicitations: SolicitationRecord[] = solRows.map((r) => {
      const returnBy = r.return_by ? new Date(r.return_by).toISOString().slice(0, 10) : null;
      const rec: SolicitationRecord = {
        solNumber: r.sol_number,
        nsn: r.nsn,
        fsc: r.fsc,
        nomenclature: r.nomenclature,
        itemName: r.item_name,
        quantity: r.quantity !== null ? Number(r.quantity) : null,
        unitOfIssue: r.unit_of_issue,
        issuedOn: r.issued_on ? new Date(r.issued_on).toISOString().slice(0, 10) : null,
        returnBy,
        status: r.status,
        setaside: r.setaside,
        buyerOffice: r.buyer_office,
        source: r.source,
        sourceUrl: assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number}`),
      };

      if (rec.nsn) {
        if (!solicitationsByNsn.has(rec.nsn)) solicitationsByNsn.set(rec.nsn, []);
        solicitationsByNsn.get(rec.nsn)!.push(rec);
        allSolNsnCodesSet.add(rec.nsn);
        if (rec.status === 'open') openNsnCodesSet.add(rec.nsn);
      }
      if (rec.fsc) {
        if (!solicitationsByFsc.has(rec.fsc)) {
          solicitationsByFsc.set(rec.fsc, { fsc: rec.fsc, name: r.fsc_name ?? null, solicitations: [] });
        }
        solicitationsByFsc.get(rec.fsc)!.solicitations.push(rec);
        if (rec.status === 'open') {
          if (!openByFsc.has(rec.fsc)) {
            openByFsc.set(rec.fsc, { fsc: rec.fsc, name: r.fsc_name ?? null, solicitations: [] });
          }
          openByFsc.get(rec.fsc)!.solicitations.push(rec);
        }
      }
      if (rec.status !== 'open') {
        closedSolicitationsCount += 1;
      } else {
        if (rec.returnBy && new Date(rec.returnBy) <= closingSoonCutoff) openClosingSoon += 1;
        openTotalQuantity += rec.quantity ?? 0;
      }

      return rec;
    });
    const totalSolicitations = allSolicitations.length;
    // Open-only subset, closing-soonest first (return_by ascending) — the
    // /open/ storefront and closing-soon board depend on this ordering,
    // distinct from the newest-first order of allSolicitations above.
    const openSolicitations: SolicitationRecord[] = allSolicitations
      .filter((s) => s.status === 'open')
      .sort((a, b) => {
        if (a.returnBy === b.returnBy) return a.solNumber.localeCompare(b.solNumber);
        if (a.returnBy === null) return 1;
        if (b.returnBy === null) return -1;
        return a.returnBy.localeCompare(b.returnBy);
      });
    const openNsnCodes = [...openNsnCodesSet];
    const allSolNsnCodes = [...allSolNsnCodesSet];

    // Catalog metadata for every NSN with ANY solicitation on record (open
    // or closed), independent of the deep-FSC gate, so solicitation cards
    // can render a thumbnail/material/competition read even when the NSN's
    // FSC isn't part of the deep-rendered catalog.
    const openNsnByNsn = new Map<string, NsnRecord>();
    if (allSolNsnCodes.length > 0) {
      const openNsnRes = await pool.query(
        `${NSN_WITH_AMSC_SELECT} WHERE n.nsn = ANY($1) ORDER BY n.nsn`,
        [allSolNsnCodes]
      );
      for (const r of openNsnRes.rows) {
        const rec = mapNsnRow(r);
        openNsnByNsn.set(rec.nsn, rec);
      }
    }

    // Build-time coverage check: how many open NSNs get a thumbnail drawing
    // from the FSC archetypes in diagram.ts, and which FSCs are still bare.
    // Log-only (guarded so a bad characteristics blob can never fail the
    // build) — this just tracks archetype coverage as new part-family
    // generators are added to diagram.ts.
    try {
      const fscCoverage = new Map<string, { has: number; total: number }>();
      let hasDrawing = 0;
      let withCharacteristics = 0;
      for (const rec of openNsnByNsn.values()) {
        const chars = parseCharacteristics(rec.characteristics);
        if (chars.length > 0) withCharacteristics += 1;
        const thumb = rec.fsc ? buildThumbnail(chars, rec.fsc, rec.itemName) : null;
        const bucket = fscCoverage.get(rec.fsc) ?? { has: 0, total: 0 };
        bucket.total += 1;
        if (thumb) {
          bucket.has += 1;
          hasDrawing += 1;
        }
        fscCoverage.set(rec.fsc, bucket);
      }
      const totalOpen = openNsnByNsn.size;
      const pct = totalOpen > 0 ? ((hasDrawing / totalOpen) * 100).toFixed(1) : '0.0';
      const topFscs = [...fscCoverage.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 15)
        .map(([fscCode, v]) => `${fscCode}=${v.has}/${v.total}`)
        .join(', ');
      console.log(
        `DRAWING-COVERAGE solicitations: ${hasDrawing} / ${totalOpen} NSNs with any solicitation (${pct}%); ` +
          `with-characteristics: ${withCharacteristics}; top FSCs: ${topFscs}`
      );
    } catch (err) {
      console.warn('DRAWING-COVERAGE: coverage check failed (non-fatal)', err);
    }

    // Open service notices from SAM.gov: letter-coded (service PSC) or
    // uncoded rows, open today. Only the fields the /services/ pages need are
    // selected, not the whole raw record.
    const svcRes = await pool.query<ServiceNoticeRow>(
      `SELECT s.sol_number, s.nomenclature, s.fsc, s.setaside, s.buyer_office,
              s.issued_on, s.return_by, s.source_url,
              s.raw ->> 'naicsCode' AS naics,
              s.raw ->> 'type' AS notice_type,
              s.raw ->> 'typeOfSetAsideDescription' AS setaside_desc,
              s.raw -> 'placeOfPerformance' -> 'state' ->> 'code' AS state
       FROM pub.solicitations s
       WHERE s.source = 'sam_gov' AND s.status = 'open'
         AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)
         AND (s.fsc IS NULL OR s.fsc ~ '^[A-Za-z]')`
    );
    const serviceNotices: ServiceNotice[] = svcRes.rows
      .map((r) => {
        assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number} (service notice)`);
        return mapServiceNotice(r);
      })
      .sort(compareByClosing);
    const serviceNoticesByCategory = new Map<string, ServiceNotice[]>();
    const serviceNoticesByFsg = new Map<string, ServiceNotice[]>();
    for (const n of serviceNotices) {
      if (!serviceNoticesByCategory.has(n.category)) serviceNoticesByCategory.set(n.category, []);
      serviceNoticesByCategory.get(n.category)!.push(n);
      if (n.fsg) {
        if (!serviceNoticesByFsg.has(n.fsg)) serviceNoticesByFsg.set(n.fsg, []);
        serviceNoticesByFsg.get(n.fsg)!.push(n);
      }
    }

    const viz = await loadVizData(pool);

    return {
      viz,
      deepFscs,
      nsns,
      nsnByNsn,
      nsnsByFsc,
      partNumbersByNsn,
      pricePointsByNsn,
      contractActionsByNsn,
      contractActionsByFsc,
      agencies: [...agencyMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      purchasesByAgency,
      solicitationsByNsn,
      openSolicitations,
      openByFsc,
      solicitationsByFsc,
      openNsnCodes,
      openNsnByNsn,
      serviceNotices,
      serviceNoticesByCategory,
      serviceNoticesByFsg,
      stats: {
        totalNsns: nsns.length,
        totalPurchases,
        totalDollars,
        totalActions,
        totalObligated,
        openSolicitationsCount: openSolicitations.length,
        openClosingSoon,
        openTotalQuantity,
        totalSolicitations,
        closedSolicitationsCount,
      },
    };
  } finally {
    await pool.end();
  }
}


// ---------------------------------------------------------------------------
// Chart aggregates. Every feature is one grouped query; the pages only look
// results up by class. "Open" = status 'open' and not past its return_by.
// "Product" = a 4-digit class that is not excluded (the open lane's rule).

const OPEN_NOW = `s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)`;
const PRODUCT = `s.fsc ~ '^[0-9]{4}$' AND COALESCE(f.render_depth, '') <> 'excluded'`;
const NOT_EXCLUDED_JOIN = `LEFT JOIN pub.fsc f ON f.fsc = s.fsc`;

async function loadVizData(pool: pgTypes.Pool): Promise<SiteViz> {
  const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

  const tiles = (
    await pool.query(
      // The tile definitions are exactly those of db/freshness.mjs recordDailyStats.
      `SELECT CURRENT_DATE::text AS today,
         (SELECT count(*) FROM pub.solicitations s
            WHERE s.status = 'open' AND (s.return_by IS NULL OR s.return_by >= CURRENT_DATE)
              AND (s.fsc IS NULL OR s.fsc ~ '^[0-9]{4}$'))::int AS open,
         (SELECT max(issued_on)::text FROM pub.solicitations WHERE source = 'dibbs_rfq') AS posted_on,
         (SELECT count(*) FROM pub.solicitations s
            WHERE s.source = 'dibbs_rfq' AND s.issued_on >= CURRENT_DATE - 7)::int AS posted,
         (SELECT count(*) FROM pub.solicitations s
            WHERE s.status = 'open' AND s.return_by >= CURRENT_DATE AND s.return_by < CURRENT_DATE + 7
              AND (s.fsc IS NULL OR s.fsc ~ '^[0-9]{4}$'))::int AS closing7,
         (SELECT coalesce(sum(obligation), 0) FROM pub.contract_actions
            WHERE award_uid LIKE 'DIBBS-%' AND action_date >= CURRENT_DATE - 7)::float8 AS awards7,
         (SELECT min(issued_on)::text FROM pub.solicitations) AS earliest`
    )
  ).rows[0];

  let dailyStats: DailyStatRow[] = [];
  try {
    const ds = await pool.query(
      `SELECT day::text AS day, open_solicitations, posted, closing_7d, award_dollars_7d::float8 AS awards
       FROM pub.daily_stats ORDER BY day DESC LIMIT 90`
    );
    dailyStats = ds.rows
      .map((r) => ({ day: r.day as string, open: Number(r.open_solicitations), posted: Number(r.posted), closing7: Number(r.closing_7d), awards7: Number(r.awards) }))
      .reverse();
  } catch (err) {
    // The trend is optional: without the snapshot table the tiles show numbers only.
    console.warn('viz: pub.daily_stats unavailable, trend lines skipped', (err as Error).message);
  }

  const tapeRes = await pool.query(
    `SELECT s.fsc, s.nsn, n.item_name, s.nomenclature, s.quantity, s.issued_on::text AS issued_on, s.return_by::text AS return_by, s.source
     FROM pub.solicitations s
     LEFT JOIN pub.nsns n ON n.nsn = s.nsn ${NOT_EXCLUDED_JOIN}
     WHERE s.source = 'dibbs_rfq' AND ${OPEN_NOW} AND s.nsn IS NOT NULL AND ${PRODUCT}
     ORDER BY s.issued_on DESC NULLS LAST, s.sol_number
     LIMIT 24`
  );
  const tape: TapeItem[] = tapeRes.rows.map((r) => ({
    fsc: r.fsc,
    name: nomen(r.item_name ?? r.nomenclature),
    quantity: r.quantity !== null ? Number(r.quantity) : null,
    issuedOn: iso(r.issued_on),
    returnBy: iso(r.return_by),
    source: r.source,
    nsn: toDashedNsn(r.nsn),
  }));

  // Same SQL as db/freshness.mjs SOURCES; the limits are those sources' limits.
  const fresh = async (sql: string): Promise<string | null> => {
    const r = await pool.query<{ t: Date | null }>(sql);
    return r.rows[0]?.t ? new Date(r.rows[0].t).toISOString() : null;
  };
  const freshDefs: { key: string; label: string; limitHours: number; cadence: string; sql: string }[] = [
    { key: 'dibbs_rfq', label: 'DIBBS solicitations', limitHours: 48, cadence: 'updates daily', sql: `SELECT max(last_seen_at) AS t FROM pub.solicitations WHERE source = 'dibbs_rfq'` },
    { key: 'sam_gov', label: 'SAM.gov notices', limitHours: 48, cadence: 'updates daily', sql: `SELECT max(last_seen_at) AS t FROM pub.solicitations WHERE source = 'sam_gov'` },
    { key: 'dibbs_awards', label: 'DIBBS awards and prices', limitHours: 120, cadence: 'updates on business days', sql: `SELECT max(ingested_at) AS t FROM pub.contract_actions WHERE award_uid LIKE 'DIBBS-%'` },
    { key: 'publog', label: 'PUB LOG specs', limitHours: 48, cadence: 'updates nightly', sql: `SELECT max(updated_at) FILTER (WHERE characteristics IS NOT NULL) AS t FROM pub.nsns` },
    { key: 'usaspending', label: 'USAspending', limitHours: 336, cadence: 'publishes in bursts', sql: `SELECT max(ingested_at) AS t FROM pub.contract_actions WHERE award_uid NOT LIKE 'DIBBS-%'` },
  ];
  const freshness: FreshnessSource[] = [];
  for (const d of freshDefs) {
    const lastLanded = await fresh(d.sql);
    if (lastLanded) freshness.push({ key: d.key, label: d.label, lastLanded, limitHours: d.limitHours, cadence: d.cadence });
  }

  const groups: GroupDemandRow[] = (
    await pool.query(
      `SELECT left(s.fsc, 2) AS fsg, count(*)::int AS open,
              count(*) FILTER (WHERE s.return_by >= CURRENT_DATE AND s.return_by < CURRENT_DATE + 7)::int AS closing7
       FROM pub.solicitations s ${NOT_EXCLUDED_JOIN}
       WHERE ${OPEN_NOW} AND ${PRODUCT}
       GROUP BY 1 ORDER BY 2 DESC, 1`
    )
  ).rows.map((r) => ({ fsg: r.fsg, open: Number(r.open), closing7: Number(r.closing7) }));

  const closingRows = (
    await pool.query(
      `SELECT s.fsc, (s.return_by - CURRENT_DATE)::int AS d, count(*)::int AS n
       FROM pub.solicitations s ${NOT_EXCLUDED_JOIN}
       WHERE ${OPEN_NOW} AND ${PRODUCT} AND s.return_by >= CURRENT_DATE AND s.return_by < CURRENT_DATE + 30
       GROUP BY 1, 2`
    )
  ).rows;
  const closingBy = new Map<string, { d: number; n: number }[]>();
  const closingAll: { d: number; n: number }[] = [];
  for (const r of closingRows) {
    const row = { d: Number(r.d), n: Number(r.n) };
    if (!closingBy.has(r.fsc)) closingBy.set(r.fsc, []);
    closingBy.get(r.fsc)!.push(row);
    closingAll.push(row);
  }
  const closing = new Map<string, number[]>([['*', foldCalendarRows(closingAll)]]);
  for (const [fsc, rows] of closingBy) closing.set(fsc, foldCalendarRows(rows));

  const byClass = new Map<string, ClassViz>();
  const cls = (fsc: string): ClassViz => {
    let c = byClass.get(fsc);
    if (!c) byClass.set(fsc, (c = { repeat: [], weekly: [], winners: null, states: [] }));
    return c;
  };

  // Most re-bought: per NSN, solicitations issued in the last 12 months (any
  // status), kept when the item came up at least twice and ranks in the top 7
  // of its class by count or by total quantity.
  const repeatRes = await pool.query(
    `WITH g AS (
       SELECT s.fsc, s.nsn, count(*)::int AS n, coalesce(sum(s.quantity), 0)::float8 AS qty,
              (array_agg(s.nomenclature ORDER BY s.issued_on DESC NULLS LAST))[1] AS nomenclature
       FROM pub.solicitations s ${NOT_EXCLUDED_JOIN}
       WHERE s.nsn IS NOT NULL AND ${PRODUCT} AND s.issued_on >= CURRENT_DATE - INTERVAL '12 months'
       GROUP BY s.fsc, s.nsn HAVING count(*) >= 2
     ), r AS (
       SELECT g.*, row_number() OVER (PARTITION BY fsc ORDER BY n DESC, qty DESC, nsn) AS rn_n,
                   row_number() OVER (PARTITION BY fsc ORDER BY qty DESC, n DESC, nsn) AS rn_q
       FROM g
     )
     SELECT r.fsc, r.nsn, r.n, r.qty, r.nomenclature, nn.item_name
     FROM r LEFT JOIN pub.nsns nn ON nn.nsn = r.nsn
     WHERE r.rn_n <= 7 OR r.rn_q <= 7`
  );
  for (const r of repeatRes.rows) {
    cls(r.fsc).repeat.push({
      nsn: toDashedNsn(r.nsn),
      name: nomen(r.item_name ?? r.nomenclature),
      solicitations: Number(r.n),
      quantity: Number(r.qty),
    });
  }

  // Demand trend: solicitations per Monday week for the 52 most recent complete weeks.
  const weeklyRes = await pool.query(
    `SELECT s.fsc, date_trunc('week', s.issued_on)::date::text AS week, count(*)::int AS n
     FROM pub.solicitations s ${NOT_EXCLUDED_JOIN}
     WHERE ${PRODUCT} AND s.issued_on IS NOT NULL
       AND s.issued_on >= date_trunc('week', CURRENT_DATE)::date - 364
       AND s.issued_on <  date_trunc('week', CURRENT_DATE)::date
     GROUP BY 1, 2`
  );
  for (const r of weeklyRes.rows) cls(r.fsc).weekly.push({ week: r.week, n: Number(r.n) });

  // Who wins: award dollars by supplier per class, last 12 months. The label
  // is the recipient name, else the CAGE from the record, else "Unidentified".
  const winnersRes = await pool.query(
    `WITH raw AS (
       SELECT ca.psc AS fsc,
              NULLIF(upper(btrim(ca.raw ->> 'cage')), '') AS cage,
              NULLIF(btrim(ca.recipient_name), '') AS nm,
              ca.obligation
       FROM pub.contract_actions ca
       WHERE ca.psc ~ '^[0-9]{4}$' AND ca.action_date >= CURRENT_DATE - INTERVAL '12 months' AND ca.obligation IS NOT NULL
     ), g AS (
       -- One group per supplier: by CAGE when the record has one (so rows
       -- loaded before the supplier's name was known still merge), else by name.
       SELECT fsc, COALESCE(cage, 'name:' || COALESCE(nm, '')) AS k, max(cage) AS cage, max(nm) AS nm, sum(obligation) AS amt
       FROM raw GROUP BY 1, 2 HAVING sum(obligation) > 0
     ), x AS (
       SELECT g.fsc,
              COALESCE(g.nm, NULLIF(btrim(s.name), ''), CASE WHEN g.cage IS NOT NULL THEN 'CAGE ' || g.cage END, 'Unidentified supplier') AS label,
              g.amt
       FROM g LEFT JOIN pub.suppliers s ON s.cage = g.cage
     ), r AS (
       SELECT fsc, label, amt, row_number() OVER (PARTITION BY fsc ORDER BY amt DESC, label) AS rn,
              sum(amt) OVER (PARTITION BY fsc) AS total, count(*) OVER (PARTITION BY fsc) AS n
       FROM x
     )
     SELECT fsc, label, amt::float8 AS amt, rn::int, total::float8 AS total, n::int AS n FROM r WHERE rn <= 6 ORDER BY fsc, rn`
  );
  for (const r of winnersRes.rows) {
    const c = cls(r.fsc);
    if (!c.winners) c.winners = { top: [], suppliers: Number(r.n), total: Number(r.total) };
    c.winners.top.push({ label: r.label, amount: Number(r.amt) });
  }

  // Where the winning suppliers are: distinct CAGEs with awards in the class
  // over 24 months, by the state on their CAGE record.
  const statesRes = await pool.query(
    `WITH c AS (
       SELECT ca.psc AS fsc, upper(btrim(ca.raw ->> 'cage')) AS cage, sum(ca.obligation) AS amt
       FROM pub.contract_actions ca
       WHERE ca.psc ~ '^[0-9]{4}$' AND ca.action_date >= CURRENT_DATE - INTERVAL '24 months'
         AND NULLIF(btrim(ca.raw ->> 'cage'), '') IS NOT NULL
       GROUP BY 1, 2
     )
     SELECT c.fsc, upper(btrim(s.state)) AS st, count(*)::int AS n, coalesce(sum(c.amt), 0)::float8 AS amt
     FROM c LEFT JOIN pub.suppliers s ON s.cage = c.cage
     GROUP BY 1, 2`
  );
  for (const r of statesRes.rows) cls(r.fsc).states.push({ state: r.st ?? null, suppliers: Number(r.n), amount: Math.max(0, Number(r.amt)) });

  return {
    today: tiles.today,
    earliestSolicitation: iso(tiles.earliest),
    tape,
    freshness,
    tiles: { open: Number(tiles.open), posted: Number(tiles.posted), postedOn: iso(tiles.posted_on), closing7: Number(tiles.closing7), awards7: Number(tiles.awards7) },
    dailyStats,
    groups,
    closing,
    byClass,
  };
}
