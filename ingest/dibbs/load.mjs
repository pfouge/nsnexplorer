#!/usr/bin/env node
// ingest/dibbs/load.mjs
// Loads DIBBS award/RFQ records (already mapped to the canonical field
// shape below — see parse.mjs for the raw-file -> record mapping, which is
// itself pending layout confirmation) into pub.suppliers, pub.solicitations,
// pub.price_points and pub.amsc_observations.
//
// Canonical award record shape:
//   { solNumber, nsn, awardDate, quantity, unitPrice, total, cage,
//     nomenclature, amsc, amc }
// Canonical RFQ record shape:
//   { solNumber, nsn, issuedOn, returnBy, quantity, unitOfIssue,
//     buyerOffice, setaside, cage, nomenclature, amsc, amc }
//
// Guard: any award record with unit_price <= 0 or an unparseable NSN is
// skipped and logged (not written at all) — a wrong or missing price/NSN
// on a public price chart is worse than a gap.
//
// This module refuses to run against real parsed DIBBS files until the
// layout is confirmed (see ingest/dibbs/parse.mjs LAYOUT_CONFIRMED) —
// throws the literal string 'LAYOUT_UNCONFIRMED'.
//
// loadAwardGridActions (below) is the totals-only counterpart for
// parseAwardGrid records: the DIBBS award grid publishes total contract
// price but never unit price, so those rows load as pub.contract_actions
// (award totals — a context layer, like the USAspending loader) rather
// than pub.price_points (reserved for true unit prices). It is NOT gated
// on LAYOUT_CONFIRMED — the grid layout IS confirmed (see
// docs/dibbs-ingest-findings.md "Award grid — CONFIRMED"); that flag only
// protects the future unit-price path in loadAwardRecords above.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tx, upsert, getPool, chunk } from '../../shared/db.mjs';
import { normalizeNsn } from '../../shared/nsn.mjs';
import { LAYOUT_CONFIRMED } from './parse.mjs';
import { mapRfqRecord } from './map-rfq.mjs';
import { norm } from './join-validate.mjs';

// Authoritative FSC (4-digit Federal Supply Class) titles, e.g.
// { "5331": "O-Ring" } — sourced from the DoD H2 "Federal Supply
// Classification Groups and Classes" handbook, corroborated against
// current NSN-lookup catalogs (see the fsc-names-backfill workflow/PR for
// the full sourcing notes). Loaded once at module load; a missing/unparsable
// file must never crash ingestion — pub.fsc rows just keep the placeholder
// name ('FSC ' || fsc) that isPlaceholderFscName (web/src/lib/browse.ts)
// already knows how to hide from rendering.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let FSC_NAMES = {};
try {
  FSC_NAMES = JSON.parse(
    readFileSync(path.join(__dirname, '../reference/fsc-names.json'), 'utf8')
  );
} catch {
  // Missing/invalid reference file: fall back to placeholder FSC names only.
  FSC_NAMES = {};
}

function assertLayoutConfirmed() {
  if (!LAYOUT_CONFIRMED) {
    throw new Error('LAYOUT_UNCONFIRMED');
  }
}

function awardUrl(nsn) {
  return `https://www.dibbs.bsm.dla.mil/Awards/AwdRecs.aspx?category=awdnsn&TypeSrch=cq&Value=${nsn}`;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Loads DIBBS award records. Writes pub.suppliers, pub.solicitations,
 * pub.price_points (source='dibbs_award'), and pub.amsc_observations when
 * AMSC is present. Never called with real data until LAYOUT_CONFIRMED.
 *
 * @param {object[]} records
 * @returns {Promise<{loaded: number, skipped: {record: object, reason: string}[]}>}
 */
export async function loadAwardRecords(records) {
  assertLayoutConfirmed();

  const skipped = [];
  let loaded = 0;

  for (const rec of records) {
    const nsn = normalizeNsn(rec.nsn);
    const unitPrice = toNumber(rec.unitPrice);

    if (!nsn) {
      skipped.push({ record: rec, reason: 'unparseable NSN' });
      continue;
    }
    if (unitPrice === null || unitPrice <= 0) {
      skipped.push({ record: rec, reason: 'unit_price <= 0 or missing' });
      continue;
    }

    await tx(async (client) => {
      if (rec.cage) {
        await client.query(
          `INSERT INTO pub.suppliers (cage) VALUES ($1) ON CONFLICT (cage) DO NOTHING`,
          [rec.cage]
        );
      }

      const sourceUrl = awardUrl(nsn);

      await client.query(
        `INSERT INTO pub.solicitations
           (sol_number, nsn, quantity, issued_on, status, amc, amsc, source_url, raw)
         VALUES ($1,$2,$3,$4,'awarded',$5,$6,$7,$8)
         ON CONFLICT (sol_number) DO UPDATE SET
           nsn = EXCLUDED.nsn,
           quantity = EXCLUDED.quantity,
           status = 'awarded',
           amc = COALESCE(EXCLUDED.amc, pub.solicitations.amc),
           amsc = COALESCE(EXCLUDED.amsc, pub.solicitations.amsc),
           updated_at = now()`,
        [
          rec.solNumber,
          nsn,
          toNumber(rec.quantity),
          rec.awardDate || null,
          rec.amc || null,
          rec.amsc || null,
          sourceUrl,
          JSON.stringify(rec),
        ]
      );

      await client.query(
        `INSERT INTO pub.price_points
           (nsn, awarded_on, unit_price, quantity, total_value, cage, sol_number,
            award_ref, source, source_url, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dibbs_award',$9,$10)
         ON CONFLICT (source, award_ref, nsn, awarded_on) DO NOTHING`,
        [
          nsn,
          rec.awardDate,
          unitPrice,
          toNumber(rec.quantity),
          toNumber(rec.total),
          rec.cage || null,
          rec.solNumber,
          rec.solNumber,
          sourceUrl,
          JSON.stringify(rec),
        ]
      );

      if (rec.amsc) {
        await upsert(
          'pub.amsc_observations',
          ['nsn', 'observed_on', 'source', 'source_ref'],
          {
            nsn,
            amc: rec.amc || null,
            amsc: rec.amsc,
            observed_on: rec.awardDate,
            source: 'dibbs_award',
            source_ref: rec.solNumber,
            source_url: sourceUrl,
          },
          { client }
        );
      }
    });

    loaded += 1;
  }

  return { loaded, skipped };
}

/**
 * Loads currently-open DIBBS RFQ solicitations (parseRfqGrid records) into
 * pub.solicitations, across the ENTIRE catalog (all FSCs) — see
 * db/migrations/0003_open_solicitations.sql. NSN-keyed rows only (see
 * map-rfq.mjs's mapRfqRecord for why): every accepted row also grows
 * pub.fsc (placeholder name) and pub.nsns so the NSN gets a catalog page.
 *
 * Not gated on LAYOUT_CONFIRMED — same rationale as loadAwardGridActions:
 * the RFQ grid is the exact same confirmed GridView shape as the award grid
 * (see parse.mjs's groupGridRows comment), just different columns.
 *
 * @param {object[]} records - parseRfqGrid records
 * @param {{ pool?: import('pg').Pool, today: string, crawlStartedAt?: string }} opts
 *   `today` is an ISO 'YYYY-MM-DD' string (see map-rfq.mjs's mapRfqRecord).
 * @returns {Promise<{ loaded: number, skipped: number, skipReasons: Record<string, number> }>}
 */
export async function loadRfqSolicitations(records, { pool, today } = {}) {
  const db = pool || getPool();

  const skipReasons = {};
  let skipped = 0;
  const plans = [];

  for (const rec of records) {
    const result = mapRfqRecord(rec, { today });
    if (result.skip) {
      skipped += 1;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }
    plans.push(result);
  }

  // Dedup for batched writes. A single crawl can surface the same NSN or
  // solicitation on many pages/dates; multi-row upserts must not hit the same
  // conflict target twice in one statement, so collapse duplicates first
  // (last occurrence wins for solicitations — most recent crawl state).
  const fscSet = new Set();
  const nsnMap = new Map(); // nsn -> { fsc, nomenclature }
  const solMap = new Map(); // sol_number -> plan
  for (const plan of plans) {
    fscSet.add(plan.fsc);
    if (!nsnMap.has(plan.nsn)) nsnMap.set(plan.nsn, { fsc: plan.fsc, nomenclature: plan.nomenclature });
    solMap.set(plan.row.sol_number, plan);
  }
  // Every lane that upserts pub.nsns / pub.solicitations writes its rows in
  // key order, so two lanes running at once take row locks in the same
  // order and cannot deadlock each other.
  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const fscList = [...fscSet].sort(byKey);
  const nsnList = [...nsnMap.entries()].sort((a, b) => byKey(a[0], b[0]));
  const solPlans = [...solMap.values()].sort((a, b) => byKey(a.row.sol_number, b.row.sol_number));

  // 1) FSCs — real title when we have one authoritatively sourced (see
  // FSC_NAMES above), placeholder 'FSC NNNN' otherwise. The DO UPDATE only
  // fires when the existing row is STILL a placeholder (name LIKE 'FSC %')
  // — a curated/real name already in place is never clobbered.
  for (const c of chunk(fscList, 1000)) {
    const params = [];
    const tuples = c.map((fsc, i) => {
      params.push(fsc, FSC_NAMES[fsc] || null);
      return `($${i * 2 + 1}::text, COALESCE($${i * 2 + 2}, 'FSC ' || $${i * 2 + 1}::text))`;
    });
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.fsc (fsc, name)
           VALUES ${tuples.join(',')}
           ON CONFLICT (fsc) DO UPDATE SET name = EXCLUDED.name
             WHERE pub.fsc.name LIKE 'FSC %'`,
          params
        ),
      { pool: db, label: 'rfq fsc' }
    );
  }

  // 2) NSNs — batched multi-row upsert (grows the catalog for open NSNs).
  // One short transaction per batch: row locks are held for milliseconds,
  // not for the whole load.
  for (const c of chunk(nsnList, 500)) {
    const params = [];
    const tuples = c.map(([nsn, meta], i) => {
      const b = i * 3;
      params.push(nsn, meta.fsc, meta.nomenclature);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    });
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.nsns (nsn, fsc, item_name)
           VALUES ${tuples.join(',')}
           ON CONFLICT (nsn) DO UPDATE SET
             item_name = COALESCE(pub.nsns.item_name, EXCLUDED.item_name),
             updated_at = now()`,
          params
        ),
      { pool: db, label: 'rfq nsns' }
    );
  }

  // 3) Solicitations — batched multi-row upsert.
  let loaded = 0;
  for (const c of chunk(solPlans, 500)) {
    const params = [];
    const tuples = c.map(({ row }, i) => {
      const b = i * 10;
      params.push(
        row.sol_number, row.nsn, row.quantity, row.issued_on, row.return_by,
        row.status, row.nomenclature, row.fsc, row.source_url, JSON.stringify(row.raw)
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},'dibbs_rfq',$${b + 7},$${b + 8},$${b + 9},$${b + 10},now())`;
    });
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.solicitations
             (sol_number, nsn, quantity, issued_on, return_by, status, source,
              nomenclature, fsc, source_url, raw, last_seen_at)
           VALUES ${tuples.join(',')}
           ON CONFLICT (sol_number) DO UPDATE SET
             nsn = EXCLUDED.nsn,
             quantity = EXCLUDED.quantity,
             issued_on = EXCLUDED.issued_on,
             return_by = EXCLUDED.return_by,
             status = EXCLUDED.status,
             nomenclature = EXCLUDED.nomenclature,
             fsc = EXCLUDED.fsc,
             source_url = EXCLUDED.source_url,
             raw = EXCLUDED.raw,
             last_seen_at = now(),
             updated_at = now()`,
          params
        ),
      { pool: db, label: 'rfq solicitations' }
    );
    loaded += c.length;
  }

  console.log(
    `loadRfqSolicitations: ${loaded} loaded, ${skipped} skipped ${JSON.stringify(skipReasons)}`
  );
  return { loaded, skipped, skipReasons };
}

/**
 * Reconciles pub.solicitations against reality after a DIBBS RFQ crawl:
 *
 *   - Always: flips any 'open' row whose return_by has passed to 'expired'
 *     (belt-and-suspenders — mapRfqRecord already computes this at load
 *     time, but rows not re-observed in a partial/incremental crawl still
 *     need their status corrected as return_by dates pass).
 *   - Only when `mode === 'full'` (a full-window recrawl of every currently
 *     open solicitation just completed, so "not seen this run" means "DIBBS
 *     no longer lists it"): flips any 'open' dibbs_rfq row not touched by
 *     this crawl (last_seen_at < crawlStartedAt) to 'cancelled'. This must
 *     NOT run after a partial/incremental crawl (e.g. "today's postings
 *     only"), which would wrongly cancel open rows the crawl simply didn't
 *     revisit.
 *
 * @param {{ pool?: import('pg').Pool, mode: 'full'|'expiry-only', crawlStartedAt?: string }} opts
 * @returns {Promise<{ expired: number, cancelled: number }>}
 */
export async function reconcileOpenSolicitations({ pool, mode, crawlStartedAt, cancelWindowDays = 25 } = {}) {
  const db = pool || getPool();

  // Definitive close: quotes are due, the RFQ is no longer open. The row is
  // KEPT (status flips to expired) — records are never deleted; they become
  // part of the accumulating history.
  const expiredResult = await db.query(
    `UPDATE pub.solicitations
       SET status = 'expired', updated_at = now()
     WHERE status = 'open'
       AND return_by IS NOT NULL
       AND return_by < CURRENT_DATE`
  );
  const expired = expiredResult.rowCount || 0;

  let cancelled = 0;
  if (mode === 'full') {
    if (!crawlStartedAt) {
      throw new Error("reconcileOpenSolicitations: crawlStartedAt is required when mode === 'full'");
    }
    // A full crawl re-observes every issue date in its window. An open RFQ we
    // DIDN'T re-observe was pulled from DIBBS → mark cancelled (still kept).
    // CRITICAL for history integrity: only touch rows issued INSIDE the crawl
    // window. A row issued before the window simply wasn't re-crawled (its
    // date is out of range) — absence there is meaningless, so leave it be
    // (it will expire naturally via return_by). Without this guard, every
    // aged-out-but-still-open record would be wrongly cancelled.
    const cancelledResult = await db.query(
      `UPDATE pub.solicitations
         SET status = 'cancelled', updated_at = now()
       WHERE source = 'dibbs_rfq'
         AND status = 'open'
         AND last_seen_at < $1
         AND issued_on IS NOT NULL
         AND issued_on >= CURRENT_DATE - $2::int`,
      [crawlStartedAt, cancelWindowDays]
    );
    cancelled = cancelledResult.rowCount || 0;
  }

  console.log(`reconcileOpenSolicitations: ${expired} expired, ${cancelled} cancelled (mode=${mode})`);
  return { expired, cancelled };
}

/**
 * Makes sure every CAGE in `cages` has a pub.suppliers row (a bare stub when
 * we have never seen it — the PUB LOG lane fills in name and address later).
 * pub.price_points.cage and the award loaders reference pub.suppliers, so
 * this must run before any insert that carries a CAGE.
 *
 * @param {string[]} cages
 * @param {{ pool?: import('pg').Pool }} [opts]
 */
export async function ensureSuppliers(cages, { pool } = {}) {
  const list = [...new Set(cages.filter(Boolean))].sort();
  for (const c of chunk(list, 1000)) {
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.suppliers (cage)
           SELECT unnest($1::text[])
           ON CONFLICT (cage) DO NOTHING`,
          [c]
        ),
      { pool, label: 'suppliers' }
    );
  }
  return list.length;
}

/** Uppercases and validates a CAGE code (5 alphanumerics); returns null otherwise. */
function normalizeCage(raw) {
  if (raw === null || raw === undefined) return null;
  const upper = String(raw).trim().toUpperCase();
  return /^[A-Z0-9]{5}$/.test(upper) ? upper : null;
}

/**
 * Pure decision function for a single parseAwardGrid record: validates and
 * shapes the row, with no DB access, so it can be unit-tested directly (see
 * load-grid.test.mjs). `deepFscSet` is the Set of FSCs with
 * pub.fsc.render_depth = 'deep' (loadAwardGridActions fetches it once per
 * call, not per row).
 *
 * Returns `{ skip: reason }` for a rejected row, or the prepared column
 * values for an accepted one:
 *   { nsn, fsc, cage, item_name, award_uid, piid, psc, description,
 *     action_date, obligation, raw }
 *
 * @param {object} record - a parseAwardGrid record ({ awardNumber,
 *   deliveryOrder, cage, total, awardDate, postedDate, nsnRaw, nomenclature,
 *   purchaseRequest, solicitation })
 * @param {Set<string>} deepFscSet
 */
export function planGridRow(record, deepFscSet) {
  const nsn = normalizeNsn(record.nsnRaw);
  if (!nsn) {
    return { skip: 'unparseable NSN' };
  }

  const fsc = nsn.slice(0, 4);
  // Bounds static page growth under Cloudflare Pages' 20k-file limit: only
  // NSNs in FSCs we actually render deep (per-NSN) pages for grow the
  // catalog from grid rows.
  if (!deepFscSet.has(fsc)) {
    return { skip: 'fsc not in deep set' };
  }

  // An award action needs a date and a dollar figure.
  if (record.total === null || record.total === undefined) {
    return { skip: 'missing total' };
  }
  if (!record.awardDate) {
    return { skip: 'missing award date' };
  }

  const cage = normalizeCage(record.cage);

  // The PurchaseRequest number distinguishes consolidated delivery orders
  // that would otherwise collide on awardNumber+deliveryOrder alone (see
  // docs/dibbs-ingest-findings.md "Award grid — CONFIRMED").
  const awardUid =
    'DIBBS-' +
    record.awardNumber +
    (record.deliveryOrder ? '-' + record.deliveryOrder : '') +
    (record.purchaseRequest ? '-' + record.purchaseRequest : '');
  const piid = record.awardNumber + (record.deliveryOrder ? '/' + record.deliveryOrder : '');

  return {
    nsn,
    fsc,
    cage,
    item_name: record.nomenclature || null,
    award_uid: awardUid,
    piid,
    psc: fsc,
    description: record.nomenclature || null,
    action_date: record.awardDate,
    obligation: record.total,
    // raw.nsn is how the web layer attaches contract_actions rows to NSN
    // pages — set to the normalized 13-digit NSN, not the raw grid text.
    raw: { ...record, nsn, cage },
  };
}

/**
 * Loads DIBBS award-grid rows (parseAwardGrid records) as pub.contract_actions
 * (award totals) and grows the catalog (pub.nsns, pub.suppliers) — see the
 * module header for why this is NOT pub.price_points. Not gated on
 * LAYOUT_CONFIRMED: the grid layout is confirmed; that flag only protects
 * the future unit-price path above.
 *
 * @param {object[]} records - parseAwardGrid records
 * @returns {Promise<{loaded: number, skipped: {record: object, reason: string}[]}>}
 */
export async function loadAwardGridActions(records) {
  const skipped = [];
  let loaded = 0;

  const { rows: fscRows } = await getPool().query(
    `SELECT fsc FROM pub.fsc WHERE render_depth = 'deep'`
  );
  const deepFscSet = new Set(fscRows.map((r) => r.fsc));

  const plans = [];
  for (const rec of records) {
    const plan = planGridRow(rec, deepFscSet);
    if (plan.skip) {
      skipped.push({ record: rec, reason: plan.skip });
    } else {
      plans.push(plan);
    }
  }

  // Batched, key-ordered, one short transaction per batch. The previous
  // row-at-a-time loop held a single transaction open for the whole load
  // (three round-trips per award row — hours through the pooler), keeping
  // row locks on pub.nsns the entire time; that is what deadlocked against
  // the RFQ and PUB LOG lanes and ran jobs into the 6-hour limit.
  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  const nsnMap = new Map(); // nsn -> plan (first occurrence carries the name)
  const cageSet = new Set();
  const actionMap = new Map(); // award_uid|action_date -> plan (first wins, as DO NOTHING did)
  for (const plan of plans) {
    if (!nsnMap.has(plan.nsn) || (!nsnMap.get(plan.nsn).item_name && plan.item_name)) {
      nsnMap.set(plan.nsn, plan);
    }
    if (plan.cage) cageSet.add(plan.cage);
    const key = `${plan.award_uid}|${plan.action_date}`;
    if (!actionMap.has(key)) actionMap.set(key, plan);
  }

  for (const c of chunk([...nsnMap.values()].sort((a, b) => byKey(a.nsn, b.nsn)), 500)) {
    const params = [];
    const tuples = c.map((plan, i) => {
      const b = i * 3;
      params.push(plan.nsn, plan.fsc, plan.item_name);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    });
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.nsns (nsn, fsc, item_name)
           VALUES ${tuples.join(',')}
           ON CONFLICT (nsn) DO UPDATE SET
             item_name = COALESCE(pub.nsns.item_name, EXCLUDED.item_name),
             updated_at = now()`,
          params
        ),
      { label: 'award nsns' }
    );
  }

  await ensureSuppliers([...cageSet]);

  const actions = [...actionMap.values()].sort((a, b) =>
    byKey(`${a.award_uid}|${a.action_date}`, `${b.award_uid}|${b.action_date}`)
  );
  for (const c of chunk(actions, 500)) {
    const params = [];
    const tuples = c.map((plan, i) => {
      const b = i * 9;
      params.push(
        plan.award_uid, plan.piid, plan.psc, plan.description, plan.action_date,
        plan.obligation, plan.cage, awardUrl(plan.nsn), JSON.stringify(plan.raw)
      );
      return `($${b + 1}::text,$${b + 2}::text,$${b + 3}::text,$${b + 4}::text,$${b + 5}::date,$${b + 6}::numeric,$${b + 7}::text,$${b + 8}::text,$${b + 9}::jsonb)`;
    });
    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.contract_actions
             (award_uid, piid, psc, description, action_date, obligation,
              recipient_name, source_url, raw)
           SELECT v.award_uid, v.piid, v.psc, v.description, v.action_date,
                  v.obligation, s.name, v.source_url, v.raw
           FROM (VALUES ${tuples.join(',')})
             AS v(award_uid, piid, psc, description, action_date, obligation,
                  cage, source_url, raw)
           LEFT JOIN pub.suppliers s ON s.cage = v.cage
           ON CONFLICT (award_uid, action_date) DO NOTHING`,
          params
        ),
      { label: 'award actions' }
    );
  }
  loaded = plans.length;

  console.log(
    `loadAwardGridActions: ${loaded} loaded, ${skipped.length} skipped`
  );
  return { loaded, skipped };
}

/**
 * Pure, DB-free decision function for the award->pub.solicitations
 * price-history join (see this module's header note above
 * loadPricePointsFromAwards for the strategy). Given one parseAwardGrid
 * record and a Map of norm(sol_number) -> { sol_number, nsn, quantity }
 * built from a `SELECT sol_number, nsn, quantity FROM pub.solicitations
 * WHERE source = 'dibbs_rfq'` snapshot, decides whether a pub.price_points
 * row can be derived, with no DB access — so it's directly unit-testable
 * (see price-join.test.mjs).
 *
 * `matched` is true whenever the award's (normalized) solicitation number
 * was found in `solicitationsByNorm` at all — i.e. we found the RFQ we
 * were awarded against — independent of whether the row then passes the
 * data-honesty checks below. This lets callers distinguish "never found
 * the underlying RFQ" from "found it, but the data was unusable."
 *
 * DATA-HONESTY: a matched award is still skipped (never returns
 * price_points fields) when the matched solicitation has no nsn, no
 * positive quantity, when the award record itself has no award date or
 * award number, or when the resulting unit_price is not a positive
 * number — a wrong or missing price/NSN on a public price chart is worse
 * than a gap.
 *
 * @param {object} record - a parseAwardGrid record ({ awardNumber,
 *   deliveryOrder, cage, total, awardDate, postedDate, nsnRaw,
 *   nomenclature, purchaseRequest, solicitation })
 * @param {Map<string, {sol_number: string, nsn: string|null, quantity: number|string|null}>} solicitationsByNorm
 * @returns {{ matched: boolean, skip: string }
 *   | { matched: true, nsn: string, awarded_on: string, unit_price: number,
 *       quantity: number, total_value: number, cage: string|null,
 *       sol_number: string, award_ref: string, source_url: string, raw: object }}
 */
export function mapAwardToPricePoint(record, solicitationsByNorm) {
  const total = toNumber(record.total);
  if (!record.solicitation || total === null || total <= 0) {
    return { matched: false, skip: 'no solicitation number or non-positive total' };
  }

  const sol = solicitationsByNorm.get(norm(record.solicitation));
  if (!sol) {
    return { matched: false, skip: 'no matching persisted solicitation' };
  }

  // From here on we DID find the persisted RFQ this award belongs to
  // (matched = true) — remaining checks are data-honesty guards on
  // whether we can actually derive a trustworthy unit price from it.
  if (!sol.nsn) {
    return { matched: true, skip: 'matched solicitation has no nsn' };
  }

  const quantity = toNumber(sol.quantity);
  if (quantity === null || quantity <= 0) {
    return { matched: true, skip: 'matched solicitation has no positive quantity' };
  }

  if (!record.awardDate) {
    return { matched: true, skip: 'award record has no awardDate' };
  }

  if (!record.awardNumber) {
    return { matched: true, skip: 'award record has no awardNumber' };
  }

  const unitPrice = total / quantity;
  if (!(unitPrice > 0)) {
    return { matched: true, skip: 'computed unit_price <= 0' };
  }

  const awardRef = record.awardNumber + (record.deliveryOrder ? '-' + record.deliveryOrder : '');

  return {
    matched: true,
    nsn: sol.nsn,
    awarded_on: record.awardDate,
    unit_price: unitPrice,
    quantity,
    total_value: total,
    cage: normalizeCage(record.cage),
    sol_number: sol.sol_number,
    award_ref: awardRef,
    source_url: awardUrl(sol.nsn),
    raw: record,
  };
}

/**
 * Continuous award<->RETAINED-solicitation price join. Instead of joining a
 * freshly-crawled award set against a freshly-crawled RFQ set (the old
 * join-validate.mjs approach — their crawl windows don't overlap in
 * solicitation-space, hence its near-zero match rate), this joins crawled
 * AWARDS against the PERSISTED pub.solicitations table, which retains every
 * RFQ we've ever captured (open + closed — see
 * db/migrations/0003_open_solicitations.sql and load.mjs's
 * reconcileOpenSolicitations, which flips status but never deletes rows).
 * An award posted today for an RFQ captured weeks ago matches by
 * solicitation number, so match rate — and price history — grows as the
 * retained solicitations set ages, without needing overlapping crawl
 * windows.
 *
 * Loads the full pub.solicitations (source='dibbs_rfq') table once into
 * memory (~35k rows is fine — see mapAwardToPricePoint's
 * solicitationsByNorm param), then batches the matched, honesty-checked
 * rows into a multi-row upsert into pub.price_points
 * (source='dibbs_award'), deduped within the batch by the
 * (source, award_ref, nsn, awarded_on) conflict key (last occurrence wins).
 *
 * @param {object[]} awardRecords - parseAwardGrid records
 * @param {{ pool?: import('pg').Pool }} [opts]
 * @returns {Promise<{ matched: number, loaded: number, skipped: number, skipReasons: Record<string, number> }>}
 */
export async function loadPricePointsFromAwards(awardRecords, { pool } = {}) {
  const db = pool || getPool();

  const { rows: solRows } = await db.query(
    `SELECT sol_number, nsn, quantity FROM pub.solicitations WHERE source = 'dibbs_rfq'`
  );
  const solicitationsByNorm = new Map();
  for (const row of solRows) {
    solicitationsByNorm.set(norm(row.sol_number), row);
  }

  let matched = 0;
  let skipped = 0;
  const skipReasons = {};
  const plans = [];

  for (const rec of awardRecords) {
    const result = mapAwardToPricePoint(rec, solicitationsByNorm);
    if (result.matched) matched += 1;
    if (result.skip) {
      skipped += 1;
      skipReasons[result.skip] = (skipReasons[result.skip] || 0) + 1;
      continue;
    }
    plans.push(result);
  }

  // Dedup within batch by the ON CONFLICT target — a single crawl can
  // surface the same award/NSN/date combination on more than one grid page;
  // multi-row upserts must not hit the same conflict target twice in one
  // statement. Last occurrence wins (most-recently-parsed page).
  const dedup = new Map();
  for (const p of plans) {
    dedup.set(`${p.award_ref}|${p.nsn}|${p.awarded_on}`, p);
  }
  const finalPlans = [...dedup.values()].sort((a, b) => {
    const ka = `${a.award_ref}|${a.nsn}|${a.awarded_on}`;
    const kb = `${b.award_ref}|${b.nsn}|${b.awarded_on}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // pub.price_points.cage references pub.suppliers. An award can go to a
  // CAGE no other lane has recorded yet, which used to fail the whole load
  // on price_points_cage_fkey — so create the missing supplier stubs first.
  await ensureSuppliers(finalPlans.map((p) => p.cage), { pool: db });

  let loaded = 0;
  for (const c of chunk(finalPlans, 500)) {
    const params = [];
    const tuples = c.map((p, i) => {
      const b = i * 10;
      params.push(
        p.nsn, p.awarded_on, p.unit_price, p.quantity, p.total_value,
        p.cage, p.sol_number, p.award_ref, p.source_url, JSON.stringify(p.raw)
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},'dibbs_award',$${b + 9},$${b + 10})`;
    });

    await tx(
      (client) =>
        client.query(
          `INSERT INTO pub.price_points
             (nsn, awarded_on, unit_price, quantity, total_value, cage, sol_number,
              award_ref, source, source_url, raw)
           VALUES ${tuples.join(',')}
           ON CONFLICT (source, award_ref, nsn, awarded_on) DO UPDATE SET
             unit_price = EXCLUDED.unit_price,
             quantity = EXCLUDED.quantity,
             total_value = EXCLUDED.total_value,
             cage = EXCLUDED.cage,
             sol_number = EXCLUDED.sol_number,
             source_url = EXCLUDED.source_url,
             raw = EXCLUDED.raw`,
          params
        ),
      { pool: db, label: 'price points' }
    );
    loaded += c.length;
  }

  console.log(
    `loadPricePointsFromAwards: ${awardRecords.length} award records, ` +
      `matched=${matched} loaded=${loaded} skipped=${skipped} ${JSON.stringify(skipReasons)}`
  );
  return { matched, loaded, skipped, skipReasons };
}

function parseArgs(argv) {
  const args = { file: undefined, type: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--type') args.type = argv[++i];
  }
  if (!args.file) throw new Error('load.mjs: --file is required');
  if (!args.type || !['awd', 'rfq'].includes(args.type)) {
    throw new Error("load.mjs: --type must be 'awd' or 'rfq'");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = JSON.parse(await readFile(args.file, 'utf8'));
  if (args.type === 'awd') {
    const result = await loadAwardRecords(records);
    console.log(
      `load.mjs: ${result.loaded} loaded, ${result.skipped.length} skipped`
    );
    for (const s of result.skipped) {
      console.log(`  skip: ${s.reason} — ${JSON.stringify(s.record)}`);
    }
    return;
  }

  // args.type === 'rfq': prefer pipeline.mjs for the real (raw-HTML,
  // full-catalog) ingestion path — this branch just loads an already-parsed
  // records JSON file for ad-hoc use.
  const today = new Date().toISOString().slice(0, 10);
  const result = await loadRfqSolicitations(records, { today });
  console.log(
    `load.mjs: ${result.loaded} loaded, ${result.skipped} skipped ${JSON.stringify(result.skipReasons)}`
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
