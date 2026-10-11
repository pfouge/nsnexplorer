// Build-time loader for the /supplier/ leaderboard (prerendered). Reads the
// precomputed pub.supplier_stats ranks through the build's pg pool (max 4
// connections, same as data.ts); it is NEVER imported by an on-demand route or
// anything the Worker bundles. Three short queries, run one after another on
// the shared pool, then the pool is closed.

import { openPool } from './data';
import { BOARD_SIZE, type BoardData, type BoardSupplier, type StateRow } from './supplier-board';

const isoDate = (v: unknown): string | null => (v ? new Date(v as string).toISOString().slice(0, 10) : null);
const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

/** Same two tests as supplier-board.ts isSmallBusiness (a label with the word "small" that is not "Other than ..."). */
const SMALL_SQL = `(
  sam.cage IS NOT NULL AND (
    EXISTS (SELECT 1 FROM jsonb_array_elements(sam.naics) e WHERE e ->> 'small' = 'true')
    OR EXISTS (SELECT 1 FROM unnest(sam.business_types) b WHERE b ~* '\\msmall\\M' AND b !~* '^\\s*other than\\M')
  )
)`;

let cached: Promise<BoardData> | null = null;

export function loadSupplierBoard(): Promise<BoardData> {
  if (!cached) cached = fetchSupplierBoard();
  return cached;
}

async function fetchSupplierBoard(): Promise<BoardData> {
  const pool = await openPool();
  try {
    const listed = await pool.query(
      `SELECT st.cage, su.name, su.city, su.state,
              st.awards_all, st.dollars_all, st.awards_12m, st.dollars_12m, st.awards_prior_12m, st.dollars_prior_12m,
              st.nsns, st.fscs, st.rising_delta,
              st.rank_dollars_12m, st.rank_dollars_all, st.rank_wins_12m, st.rank_wins_all, st.rank_nsns, st.rank_fscs, st.rank_rising
       FROM pub.supplier_stats st
       JOIN pub.suppliers su ON su.cage = st.cage
       WHERE st.rank_dollars_12m <= $1 OR st.rank_dollars_all <= $1 OR st.rank_wins_12m <= $1 OR st.rank_wins_all <= $1
          OR st.rank_nsns <= $1 OR st.rank_fscs <= $1 OR st.rank_rising <= $1
       ORDER BY st.cage`,
      [BOARD_SIZE]
    );
    const head = await pool.query(
      `SELECT count(*)::int AS suppliers,
              COALESCE(sum(st.awards_12m), 0)::int AS awards_12m,
              COALESCE(sum(st.dollars_12m), 0) AS dollars_12m,
              count(*) FILTER (WHERE ${SMALL_SQL})::int AS small,
              count(DISTINCT su.state) FILTER (WHERE su.state ~ '^[A-Z]{2}$')::int AS states,
              max(st.refreshed_at) AS refreshed
       FROM pub.supplier_stats st
       JOIN pub.suppliers su ON su.cage = st.cage
       LEFT JOIN pub.supplier_sam sam ON sam.cage = st.cage`
    );
    const states = await pool.query(
      `SELECT su.state, count(*)::int AS suppliers, COALESCE(sum(st.dollars_12m), 0) AS dollars_12m
       FROM pub.supplier_stats st
       JOIN pub.suppliers su ON su.cage = st.cage
       WHERE su.state ~ '^[A-Z]{2}$'
       GROUP BY su.state
       ORDER BY dollars_12m DESC, suppliers DESC, su.state`
    );
    const h = head.rows[0];
    const suppliers: BoardSupplier[] = listed.rows.map((r) => ({
      cage: String(r.cage),
      name: clean(r.name),
      city: clean(r.city),
      state: clean(r.state),
      awardsAll: n(r.awards_all),
      dollarsAll: n(r.dollars_all),
      awards12m: n(r.awards_12m),
      dollars12m: n(r.dollars_12m),
      awardsPrior12m: n(r.awards_prior_12m),
      dollarsPrior12m: n(r.dollars_prior_12m),
      nsns: n(r.nsns),
      fscs: n(r.fscs),
      risingDelta: nOrNull(r.rising_delta),
      rankDollars12m: nOrNull(r.rank_dollars_12m),
      rankDollarsAll: nOrNull(r.rank_dollars_all),
      rankWins12m: nOrNull(r.rank_wins_12m),
      rankWinsAll: nOrNull(r.rank_wins_all),
      rankNsns: nOrNull(r.rank_nsns),
      rankFscs: nOrNull(r.rank_fscs),
      rankRising: nOrNull(r.rank_rising),
    }));
    return {
      headline: {
        suppliers: n(h.suppliers),
        awards12m: n(h.awards_12m),
        dollars12m: n(h.dollars_12m),
        small: n(h.small),
        states: n(h.states),
        asOf: isoDate(h.refreshed),
      },
      suppliers,
      states: states.rows.map((r): StateRow => ({ state: String(r.state), suppliers: n(r.suppliers), dollars12m: n(r.dollars_12m) })),
    };
  } finally {
    await pool.end();
  }
}
