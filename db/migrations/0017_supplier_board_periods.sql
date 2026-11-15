-- 0017: supplier leaderboard periods, rank trend and long-term-contract-only suppliers (2026-11-15).
--
-- Adds to pub.supplier_stats and pub.refresh_supplier_stats():
--   1. A 90-day period: awards_90d, dollars_90d, rank_dollars_90d, rank_wins_90d. "Last 90 days" means
--      awarded_on > CURRENT_DATE - 90, the same style of window as the 12-month one (> CURRENT_DATE - 365).
--   2. A rank trend: rank_dollars_12m_prev is the 12-month dollar rank as it would have been 30 days ago, computed
--      from the same price points over the 365 days ending 30 days ago (awarded_on > CURRENT_DATE - 395 AND
--      awarded_on <= CURRENT_DATE - 30), ranked like rank_dollars_12m (dollars DESC, cage in C collation).
--      There is no rank history table: this is a recomputation, so an award recorded late moves the "old" rank too.
--      NULL when the supplier had no dollars in that window (the page shows "new").
--   3. Suppliers whose only price points are long-term contract ceilings (migration 0015 rule) now get a row:
--      long_term_contracts counts those base awards, every purchase figure and every rank is 0 / NULL, and
--      first_award / last_award (dates of purchases) are NULL, so those two columns lose NOT NULL. Dollar ranks and
--      every count beside dollars still ignore ceilings; long_term_contracts is also filled for suppliers that have
--      both ceilings and purchases.
-- The ceiling rule is the one in web/src/lib/contract-ceiling.ts (ceilingPricePointSql('pp'), written out below);
-- web/src/lib/contract-ceiling.test.ts fails when the text drifts. Function body is otherwise as in 0015.
-- pub.supplier_stats is rebuilt by `node db/refresh-supplier-stats.mjs` (deploy.yml and ingest-daily.yml run it
-- right after migrating); until then the new columns hold their defaults (0 / NULL).
--
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

ALTER TABLE pub.supplier_stats
  ADD COLUMN IF NOT EXISTS awards_90d            int     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dollars_90d           numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rank_dollars_90d      int,
  ADD COLUMN IF NOT EXISTS rank_wins_90d         int,
  ADD COLUMN IF NOT EXISTS rank_dollars_12m_prev int,   -- 12-month dollar rank as of 30 days ago; NULL = no dollars then
  ADD COLUMN IF NOT EXISTS long_term_contracts   int     NOT NULL DEFAULT 0;
ALTER TABLE pub.supplier_stats ALTER COLUMN first_award DROP NOT NULL;
ALTER TABLE pub.supplier_stats ALTER COLUMN last_award DROP NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_stats_rank_dollars_90d ON pub.supplier_stats (rank_dollars_90d);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_wins_90d    ON pub.supplier_stats (rank_wins_90d);

CREATE OR REPLACE FUNCTION pub.refresh_supplier_stats() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  TRUNCATE pub.supplier_stats;

  INSERT INTO pub.supplier_stats (
    cage, awards_all, dollars_all, awards_12m, dollars_12m, awards_prior_12m, dollars_prior_12m,
    nsns, fscs, agencies, first_award, last_award,
    rank_dollars_12m, rank_dollars_all, rank_wins_12m, rank_wins_all, rank_nsns, rank_fscs, rank_rising,
    rising_delta, refreshed_at,
    awards_90d, dollars_90d, rank_dollars_90d, rank_wins_90d, rank_dollars_12m_prev, long_term_contracts)
  WITH pts AS (
    -- is_purchase is false for the base award of a long-term contract (a ceiling, not money spent).
    SELECT pp.cage, pp.nsn, pp.agency_id, pp.awarded_on, n.fsc,
           COALESCE(pp.total_value, pp.unit_price * pp.quantity) AS val,
           NOT COALESCE(pp.source = 'dibbs_award' AND upper(substr(pp.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in pp.award_ref) = 0, false) AS is_purchase
    FROM pub.price_points pp
    JOIN pub.nsns n ON n.nsn = pp.nsn
    WHERE pp.cage IS NOT NULL
  ), agg AS (
    SELECT p.cage,
           (count(*) FILTER (WHERE p.is_purchase))::int                                  AS awards_all,
           COALESCE(sum(p.val) FILTER (WHERE p.is_purchase), 0)                          AS dollars_all,
           (count(*) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 365))::int AS awards_12m,
           COALESCE(sum(p.val) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 365), 0) AS dollars_12m,
           (count(*) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 730
                               AND p.awarded_on <= CURRENT_DATE - 365))::int            AS awards_prior_12m,
           COALESCE(sum(p.val) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 730
                                         AND p.awarded_on <= CURRENT_DATE - 365), 0)    AS dollars_prior_12m,
           (count(*) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 90))::int AS awards_90d,
           COALESCE(sum(p.val) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 90), 0) AS dollars_90d,
           COALESCE(sum(p.val) FILTER (WHERE p.is_purchase AND p.awarded_on > CURRENT_DATE - 395
                                         AND p.awarded_on <= CURRENT_DATE - 30), 0)     AS dollars_12m_prev,
           (count(DISTINCT p.nsn) FILTER (WHERE p.is_purchase))::int                    AS nsns,
           (count(DISTINCT p.fsc) FILTER (WHERE p.is_purchase))::int                    AS fscs,
           (count(DISTINCT p.agency_id) FILTER (WHERE p.is_purchase))::int              AS agencies,
           min(p.awarded_on) FILTER (WHERE p.is_purchase)                               AS first_award,
           max(p.awarded_on) FILTER (WHERE p.is_purchase)                               AS last_award,
           (count(*) FILTER (WHERE NOT p.is_purchase))::int                             AS long_term_contracts
    FROM pts p
    GROUP BY p.cage
  ), delta AS (
    SELECT agg.*, (dollars_12m - dollars_prior_12m) AS rising_delta FROM agg
  )
  SELECT d.cage, d.awards_all, d.dollars_all, d.awards_12m, d.dollars_12m,
         d.awards_prior_12m, d.dollars_prior_12m, d.nsns, d.fscs, d.agencies,
         d.first_award, d.last_award,
         CASE WHEN d.dollars_12m > 0 THEN row_number() OVER (ORDER BY d.dollars_12m DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.dollars_all > 0 THEN row_number() OVER (ORDER BY d.dollars_all DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.awards_12m  > 0 THEN row_number() OVER (ORDER BY d.awards_12m  DESC, d.cage ASC) END,
         CASE WHEN d.awards_all  > 0 THEN row_number() OVER (ORDER BY d.awards_all  DESC, d.cage ASC) END,
         CASE WHEN d.nsns        > 0 THEN row_number() OVER (ORDER BY d.nsns        DESC, d.cage ASC) END,
         CASE WHEN d.fscs        > 0 THEN row_number() OVER (ORDER BY d.fscs        DESC, d.cage ASC) END,
         CASE WHEN d.dollars_12m >= 10000 AND d.awards_12m >= 3
              THEN row_number() OVER (
                     PARTITION BY (d.dollars_12m >= 10000 AND d.awards_12m >= 3)
                     ORDER BY d.rising_delta DESC, d.cage COLLATE "C" ASC) END,
         d.rising_delta, now(),
         d.awards_90d, d.dollars_90d,
         CASE WHEN d.dollars_90d > 0 THEN row_number() OVER (ORDER BY d.dollars_90d DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.awards_90d  > 0 THEN row_number() OVER (ORDER BY d.awards_90d  DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.dollars_12m_prev > 0 THEN row_number() OVER (ORDER BY d.dollars_12m_prev DESC, d.cage COLLATE "C" ASC) END,
         d.long_term_contracts
  FROM delta d;
  -- A metric of 0 sorts last, so ranking every row and blanking the zeros leaves 1..k on the rest. Suppliers with only
  -- long-term contracts have every metric at 0, so they take no rank anywhere.
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
