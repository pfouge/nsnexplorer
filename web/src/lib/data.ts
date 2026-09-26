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
  parseCharacteristics, slugify, assertSourceUrl, NSN_WITH_AMSC_SELECT, mapNsnRow,
} from './shared';

export * from './shared';

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

export interface SiteData {
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
      `SELECT fsc, name, fsg, render_depth FROM pub.fsc WHERE render_depth <> 'excluded' ORDER BY fsc`
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
      `SELECT s.sol_number, s.nsn, s.fsc, f.name AS fsc_name, s.nomenclature,
              s.quantity, s.unit_of_issue, s.issued_on, s.return_by, s.status,
              s.setaside, s.buyer_office, s.source, s.source_url, n.item_name
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       LEFT JOIN pub.fsc f ON f.fsc = s.fsc
       ORDER BY COALESCE(s.return_by, s.issued_on) DESC NULLS LAST, s.sol_number`
    );
    const allSolicitations: SolicitationRecord[] = solRes.rows.map((r) => {
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

    return {
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
