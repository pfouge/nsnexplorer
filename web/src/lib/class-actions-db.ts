// class-actions-db.ts — build-time SQL for pub.contract_actions (no pages import this directly).
//
// Before: one query loaded EVERY row (raw jsonb included) for the catalog's NSNs
// and classes and split them in JS. That is ~420k rows for 2 classes and would
// be ~2M for 25. Now:
//   * NSN-attached rows (raw.nsn is a catalog NSN) are still loaded whole, minus
//     the raw column: they are few and the NSN pages need them.
//   * Class-level rows (psc is a catalog class AND NOT NSN-attached) are never
//     loaded wholesale. Per class we keep a ClassActionSummary (see class-actions.ts)
//     computed by grouped SQL, and the CSV endpoints query their own files.
// "NSN-attached" is decided once, from the ids returned by the first query, so
// class-level = "psc in catalog classes AND id NOT IN (NSN-attached ids)" is the
// exact complement within one snapshot and needs no raw->>'nsn' scan of the big table.

import type pgTypes from 'pg';
import { assertSourceUrl, type ContractActionRecord } from './shared';
import {
  isUsaspendingRow,
  pulseLookbackFloor,
  RECENT_ACTION_ROWS,
  USASPENDING_URL_REGEX,
  fiscalYearBounds,
  type ClassActionSummary,
} from './class-actions';
import { CSV_MAX_ROWS } from './csv-split';
import { CONTRACT_CEILING_SQL, NOT_CONTRACT_CEILING_SQL } from './contract-ceiling';

const isoDate = (v: unknown): string | null => (v ? new Date(v as string | Date).toISOString().slice(0, 10) : null);

/** Row (with the standard column list below) to the record the pages use. Same conversions as the old inline loop. */
export function mapContractActionRow(r: Record<string, any>): ContractActionRecord {
  return {
    id: Number(r.id),
    awardUid: r.award_uid,
    piid: r.piid,
    psc: r.psc,
    naics: r.naics,
    description: r.description,
    actionDate: isoDate(r.action_date),
    obligation: r.obligation !== null ? Number(r.obligation) : null,
    agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
    agencyName: r.agency_name,
    recipientName: r.recipient_name,
    recipientUei: r.recipient_uei,
    sourceUrl: assertSourceUrl(r.source_url, `contract_actions.id=${r.id}`),
    ingestedAt: new Date(r.ingested_at).toISOString(),
    isCeiling: r.is_ceiling === true,
  };
}

const RECORD_COLUMNS = `ca.id, ca.award_uid, ca.piid, ca.psc, ca.naics, ca.description, ca.action_date,
       ca.obligation, ca.agency_id, ag.name AS agency_name, ca.recipient_name,
       ca.recipient_uei, ca.source_url, ca.ingested_at, ${CONTRACT_CEILING_SQL} AS is_ceiling`;

/**
 * "Not NSN-attached": the row's id is not in $2 (the NSN-attached ids of the same snapshot). Written as
 * <> ALL, not NOT EXISTS over unnest($2): with the array bound as a parameter Postgres hashes it once and
 * tests each row against the hash, so the condition is a plain row filter. The anti-join form had to read
 * every candidate row before any ORDER BY ... LIMIT could stop early, and rebuilt (and spilled) a hash of
 * the whole id list in every per-file CSV query. ids are never NULL, so the two forms select the same rows.
 */
const NOT_ATTACHED_SQL = `ca.id <> ALL($2::bigint[])`;

/** USAspending test in SQL: not a DIBBS award row, and the host matches (USASPENDING_URL_REGEX). $re is the regex parameter. */
const usaSql = (re: string) => `(ca.award_uid NOT LIKE 'DIBBS-%' AND ca.source_url ~* ${re})`;

export interface ContractActionLoad {
  /** NSN-attached rows by catalog NSN (rows whose raw.nsn is a catalog NSN). */
  contractActionsByNsn: Map<string, ContractActionRecord[]>;
  /** ids of every NSN-attached row; the CSV queries exclude these to get the class-level set. */
  nsnActionIds: number[];
  /** Per class with at least one class-level row. */
  summaryByFsc: Map<string, ClassActionSummary>;
  /** Rows counted by the old single query: NSN-attached plus class-level. Contract ceilings are not counted (see contract-ceiling.ts). */
  totalActions: number;
  /** Dollars across those rows. Contract ceilings are a contract's maximum value, not money spent, so they add nothing. */
  totalObligated: number;
}

/**
 * @param today ISO date (the database's CURRENT_DATE, SiteViz.today)
 */
export async function loadContractActions(
  pool: pgTypes.Pool,
  args: { nsnCodes: string[]; fscCodes: string[]; today: string }
): Promise<ContractActionLoad> {
  const { nsnCodes, fscCodes, today } = args;
  const contractActionsByNsn = new Map<string, ContractActionRecord[]>();
  const summaryByFsc = new Map<string, ClassActionSummary>();
  const nsnActionIds: number[] = [];
  let totalActions = 0;
  let totalObligated = 0;
  if (nsnCodes.length === 0 && fscCodes.length === 0) {
    return { contractActionsByNsn, nsnActionIds, summaryByFsc, totalActions, totalObligated };
  }

  // One snapshot for every query below, so the NSN-attached ids and the class-level
  // aggregates describe the same rows even if an ingest commits meanwhile.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // A. NSN-attached rows. raw is not selected, only raw->>'nsn'. ORDER BY id restores
    // the heap order the old OR-scan produced (the table is insert-ordered), so the
    // per-NSN arrays keep their order.
    if (nsnCodes.length > 0) {
      const res = await client.query(
        `SELECT ${RECORD_COLUMNS}, ca.raw ->> 'nsn' AS nsn
         FROM pub.contract_actions ca
         LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
         WHERE (ca.raw ->> 'nsn') = ANY($1)
         ORDER BY ca.id`,
        [nsnCodes]
      );
      for (const r of res.rows) {
        const rec = mapContractActionRow(r);
        // A contract ceiling is still listed on its NSN page, but is neither a purchase nor dollars spent.
        if (!rec.isCeiling) {
          totalActions += 1;
          totalObligated += rec.obligation ?? 0;
        }
        nsnActionIds.push(rec.id);
        const list = contractActionsByNsn.get(r.nsn);
        if (list) list.push(rec);
        else contractActionsByNsn.set(r.nsn, [rec]);
      }
    }

    if (fscCodes.length > 0) {
      // B. Class-level rows = psc in the catalog classes AND not NSN-attached.
      // NOT_ATTACHED_SQL is a per-row hashed lookup in the id list (see its comment).
      const classLevel = `ca.psc = ANY($1::bpchar[]) AND ${NOT_ATTACHED_SQL}`;
      const base = [fscCodes, nsnActionIds];
      const floor = pulseLookbackFloor(today);

      // B + C (+ the count guard F needs) in ONE pass over the class-level rows: the table is
      // ~1.5M rows and every pass is a full read of it. `x` evaluates each per-row test once
      // (the USAspending host regex is the costly one); `per` aggregates per (class, fiscal
      // year) in one hashed pass. x is an optimisation fence (OFFSET 0) on purpose: it hides
      // that fy is a function of action_date, whose ~3,400 distinct days made the planner
      // expect ~85k groups and sort every row instead of hashing ~200 groups.
      // The class rows (by_class = 1) add the partial counts and sums up: exactly the figures
      // of a GROUP BY psc (counts and numeric sums are exact, max of maxima is the max). The
      // (class, fy) rows (by_class = 0) are C: USAspending dated rows per fiscal year (chips and
      // the per-year CSV paths), kept where usa_dated_n > 0 (an undated row has fy NULL and
      // counts 0 there). doubtful_n counts the rows guard F looks at, so F only runs when there
      // are any.
      const agg = await client.query(
        `WITH per AS (
           SELECT x.fsc, x.fy,
                  count(*)::int AS n,
                  count(*) FILTER (WHERE x.ceiling)::int AS ceiling_n,
                  sum(x.obligation) FILTER (WHERE NOT x.ceiling) AS obligated,
                  count(*) FILTER (WHERE x.not_dibbs AND x.usa_host)::int AS usa_n,
                  count(*) FILTER (WHERE x.action_date IS NOT NULL AND x.not_dibbs AND x.usa_host)::int AS usa_dated_n,
                  max(x.action_date) AS latest_date,
                  count(*) FILTER (WHERE x.blank_url)::int AS blank_urls,
                  count(*) FILTER (WHERE x.not_dibbs AND x.url_mentions AND NOT x.usa_host)::int AS doubtful_n
           FROM (
             SELECT ca.psc::text AS fsc,
                    (extract(year FROM ca.action_date)::int + (extract(month FROM ca.action_date) >= 10)::int) AS fy,
                    ca.action_date, ca.obligation,
                    ${CONTRACT_CEILING_SQL} AS ceiling,
                    ca.award_uid NOT LIKE 'DIBBS-%' AS not_dibbs,
                    ca.source_url ~* $3 AS usa_host,
                    ca.source_url ILIKE '%usaspending%' AS url_mentions,
                    length(btrim(ca.source_url, E' \\t\\r\\n')) = 0 AS blank_url
             FROM pub.contract_actions ca
             WHERE ${classLevel}
             OFFSET 0
           ) x
           GROUP BY 1, 2
         )
         SELECT fsc, NULL::int AS fy, 1 AS by_class,
                sum(n)::int AS n, sum(ceiling_n)::int AS ceiling_n, coalesce(sum(obligated), 0)::text AS obligated,
                sum(usa_n)::int AS usa_n, NULL::int AS usa_dated_n, max(latest_date)::text AS latest_date,
                sum(blank_urls)::int AS blank_urls, sum(doubtful_n)::int AS doubtful_n
         FROM per GROUP BY fsc
         UNION ALL
         SELECT fsc, fy, 0, NULL, NULL, NULL, NULL, usa_dated_n, NULL, NULL, NULL
         FROM per WHERE usa_dated_n > 0
         ORDER BY 3 DESC, 1, 2 DESC`,
        [...base, USASPENDING_URL_REGEX]
      );
      let doubtfulRows = 0;
      for (const r of agg.rows) {
        if (r.by_class !== 1) {
          // (psc, fy) rows come after every (psc) row (ORDER BY 3 DESC), newest year first.
          if (r.usa_dated_n > 0) summaryByFsc.get(r.fsc)?.usaspendingFiscalYears.push({ fy: Number(r.fy), count: r.usa_dated_n });
          continue;
        }
        // The old loader asserted a source_url on every row it loaded; keep that guarantee.
        if (r.blank_urls > 0) assertSourceUrl('', `contract_actions psc=${r.fsc} (${r.blank_urls} rows)`);
        doubtfulRows += r.doubtful_n;
        const obligated = Number(r.obligated);
        totalActions += r.n - r.ceiling_n;
        totalObligated += obligated;
        summaryByFsc.set(r.fsc, {
          count: r.n,
          ceilingCount: r.ceiling_n,
          obligated,
          recent: [],
          usaspendingCount: r.usa_n,
          usaspendingFiscalYears: [],
          latestDate: r.latest_date,
          pulseRows: [],
        });
      }

      // D. The newest RECENT_ACTION_ROWS rows per class: the table on the class page.
      // Tie-break on id (the old JS sort left ties in arbitrary heap order).
      // Same rows as ORDER BY action_date DESC NULLS LAST, id LIMIT n, written so the
      // (psc, action_date) index serves it: the dated rows come from a backward index scan
      // (newest first, ties sorted by id), the undated rows only fill up a class with fewer
      // than n dated rows. The NSN-attached ids are excluded with <> ALL (a hashed lookup per
      // row, NOT_ATTACHED_SQL) instead of an anti-join, which would read every row of the class first.
      const recentPart = (dated: boolean) => `(
             SELECT ${RECORD_COLUMNS}
             FROM pub.contract_actions ca
             LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
             WHERE ca.psc = f.fsc AND ca.action_date IS ${dated ? 'NOT NULL' : 'NULL'} AND ${NOT_ATTACHED_SQL}
             ORDER BY ${dated ? 'ca.action_date DESC, ' : ''}ca.id
             LIMIT ${RECENT_ACTION_ROWS}
           )`;
      const recent = await client.query(
        `SELECT t.*
         FROM unnest($1::bpchar[]) AS f(fsc)
         CROSS JOIN LATERAL (
           SELECT u.* FROM (${recentPart(true)} UNION ALL ${recentPart(false)}) u
           ORDER BY u.action_date DESC NULLS LAST, u.id
           LIMIT ${RECENT_ACTION_ROWS}
         ) t
         ORDER BY t.psc, t.action_date DESC NULLS LAST, t.id`,
        base
      );
      for (const r of recent.rows) summaryByFsc.get(String(r.psc))?.recent.push(mapContractActionRow(r));

      // E. Slim rows for the class page's "Right now" stats: only the window
      // buildClassPulse can read (see pulseLookbackFloor), and nothing after today.
      const pulse = await client.query(
        `SELECT ca.psc::text AS fsc, ca.action_date, ca.obligation, ca.recipient_uei, ca.recipient_name
         FROM pub.contract_actions ca
         WHERE ${classLevel} AND ca.action_date >= $3::date AND ca.action_date <= $4::date
           AND ${NOT_CONTRACT_CEILING_SQL}
         ORDER BY ca.psc, ca.action_date DESC, ca.id`,
        [...base, floor, today]
      );
      for (const r of pulse.rows) {
        summaryByFsc.get(r.fsc)?.pulseRows.push({
          actionDate: isoDate(r.action_date)!,
          obligation: r.obligation !== null ? Number(r.obligation) : null,
          recipientUei: r.recipient_uei,
          recipientName: r.recipient_name,
        });
      }

      // F. Guard: the SQL host test must agree with isUsaspendingRow. Rows that mention
      // usaspending.gov but fail the SQL test are re-checked in JS; any the JS accepts are reported.
      // Skipped (no extra pass over the table) when the B + C statement counted no such rows.
      const doubtful = doubtfulRows === 0 ? { rows: [] as { award_uid: string; source_url: string }[] } : await client.query(
        // Unchanged statement (anti-join form kept: here the planner reads the table once either way).
        `SELECT DISTINCT ca.award_uid, ca.source_url
         FROM pub.contract_actions ca
         WHERE ca.psc = ANY($1::bpchar[]) AND NOT EXISTS (SELECT 1 FROM unnest($2::bigint[]) AS att(id) WHERE att.id = ca.id)
           AND ca.award_uid NOT LIKE 'DIBBS-%'
           AND ca.source_url ILIKE '%usaspending%' AND NOT ca.source_url ~* $3
         LIMIT 200`,
        [...base, USASPENDING_URL_REGEX]
      );
      const disagree = doubtful.rows.filter((r) => isUsaspendingRow(r.award_uid, r.source_url));
      if (disagree.length > 0) {
        console.warn(
          `class-actions: ${disagree.length}+ source_url values count as USAspending in JS but not in SQL, e.g. ${disagree
            .slice(0, 3)
            .map((r) => JSON.stringify(r.source_url))
            .join(', ')}. They are missing from the CSV downloads and chip lists.`
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { contractActionsByNsn, nsnActionIds, summaryByFsc, totalActions, totalObligated };
}

// ---------------------------------------------------------------------------
// CSV files. One query per file, only the CSV columns, same order and cap as the
// old in-memory path (newest first, then id; CSV_MAX_ROWS; USAspending rows only).

export type CsvActionRow = (string | number | null)[];

const CSV_COLUMNS = `ca.action_date, ca.piid, ca.psc, ca.naics, ca.description, ca.obligation, ag.name AS agency_name,
       ca.recipient_name, ca.source_url`;

function csvCells(r: Record<string, any>): CsvActionRow {
  return [
    isoDate(r.action_date),
    r.piid,
    r.psc,
    r.naics,
    r.description,
    r.obligation !== null ? Number(r.obligation) : null,
    r.agency_name,
    r.recipient_name,
    r.source_url,
  ];
}

/** The latest-12-months file: rows dated after `floor` (csv-split latestYearFloor), no upper bound. */
export async function loadLatestYearCsvRows(
  pool: pgTypes.Pool,
  fsc: string,
  nsnActionIds: number[],
  floor: string
): Promise<CsvActionRow[]> {
  const res = await pool.query(
    `SELECT ${CSV_COLUMNS}
     FROM pub.contract_actions ca LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
     WHERE ca.psc = $1::bpchar AND ${NOT_ATTACHED_SQL} AND ${usaSql('$3')} AND ca.action_date > $4::date
     ORDER BY ca.action_date DESC, ca.id
     LIMIT ${CSV_MAX_ROWS}`,
    [fsc, nsnActionIds, USASPENDING_URL_REGEX, floor]
  );
  return res.rows.map(csvCells);
}

/** One federal fiscal year's file. */
export async function loadFiscalYearCsvRows(
  pool: pgTypes.Pool,
  fsc: string,
  nsnActionIds: number[],
  fy: number
): Promise<CsvActionRow[]> {
  const { start, endExclusive } = fiscalYearBounds(fy);
  const res = await pool.query(
    `SELECT ${CSV_COLUMNS}
     FROM pub.contract_actions ca LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
     WHERE ca.psc = $1::bpchar AND ${NOT_ATTACHED_SQL} AND ${usaSql('$3')}
       AND ca.action_date >= $4::date AND ca.action_date < $5::date
     ORDER BY ca.action_date DESC, ca.id
     LIMIT ${CSV_MAX_ROWS}`,
    [fsc, nsnActionIds, USASPENDING_URL_REGEX, start, endExclusive]
  );
  return res.rows.map(csvCells);
}
