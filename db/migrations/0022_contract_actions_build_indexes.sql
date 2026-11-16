-- 0022 — two small partial indexes for the site build's reads of pub.contract_actions (2026-11-16).
--
-- The build (web/src/lib/data.ts) read the whole table (~1.5M rows, ~900 MB) several times for answers
-- that only need a small part of it. Two of those reads need an index; the others were rewritten to share
-- one read (see web/src/lib/data.ts, class-actions-db.ts, agency-profile-sql.ts).
--
-- 1. DIBBS award rows only (award_uid LIKE 'DIBBS%', a small share of the table):
--    * the award-coverage day (min action_date with at least 200 DIBBS rows; data.ts and
--      supplier-board-data.ts) becomes an index-only scan of this index,
--    * the DIBBS freshness maximum (max(ingested_at)) reads the newest entry of this index (one heap visit
--      to check award_uid LIKE 'DIBBS-%'),
--    * the award_pr / award_nsn CTEs of the solicitation statement read only the heap pages of DIBBS rows.
--    Queries written with 'DIBBS-%' repeat award_uid LIKE 'DIBBS%' so the planner matches the predicate.
-- 2. USAspending rows only (award_uid NOT LIKE 'DIBBS-%'): the USAspending freshness maximum
--    (max(ingested_at)) reads one index entry instead of the whole table.
--
-- Plain CREATE INDEX (db/migrate.mjs runs each file in one transaction, so CONCURRENTLY is not possible):
-- each statement reads the whole table once and holds a SHARE lock on pub.contract_actions while it builds,
-- so readers (site, Hyperdrive) carry on and writers (ingest) wait until the transaction commits. Local
-- timing on a 1.5M-row, 650 MB copy with the table cached: 0.7 s for both. On production expect roughly
-- one full read of the table per index (the build's full reads took 20 to 117 s each on 2026-11-15), so
-- apply it when no ingest is writing if possible: a writer that waits longer than its own 120 s
-- statement_timeout fails with a statement timeout.
-- The role's 120 s statement_timeout would also cancel the build itself on a busy day, so this file raises
-- it for its own transaction only (SET LOCAL ends at COMMIT).
-- Idempotent: IF NOT EXISTS.

SET LOCAL statement_timeout = '15min';

CREATE INDEX IF NOT EXISTS contract_actions_dibbs_ingested_idx
  ON pub.contract_actions (ingested_at, action_date)
  WHERE award_uid LIKE 'DIBBS%';

CREATE INDEX IF NOT EXISTS contract_actions_usaspending_ingested_idx
  ON pub.contract_actions (ingested_at)
  WHERE award_uid NOT LIKE 'DIBBS-%';
