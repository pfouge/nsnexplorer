-- 0021 — USAspending storage limits (owner decision 2026-11-15): helpers only, no data is changed here.
--
-- Two decisions:
--   1. pub.contract_actions.raw of a USAspending row keeps only what a reader needs: nsn (and cage if a
--      record ever carries one). A row with nothing to keep stores '{}' (the column is NOT NULL). The loader
--      (ingest/usaspending/load.mjs) writes that form from now on.
--   2. History kept from fiscal year 2022 (action_date >= 2021-10-01) for every class except 5330 and 5331,
--      which keep everything. The floor constants live in ingest/usaspending/history-floor.mjs.
--
-- Rewriting about 900,000 rows and deleting the old ones in the single transaction db/migrate.mjs gives each
-- file would hold one huge transaction (WAL, locks, statement timeout) while the site reads this table, and
-- every ingest workflow runs db/migrate.mjs first. So this migration only creates two functions; the existing
-- rows are cleaned by db/usaspending-storage-cleanup.mjs (workflow usaspending-storage-cleanup.yml), which
-- calls pub.usaspending_storage_cleanup_batch once per id range, each call its own short transaction.
-- The functions are pure SQL, re-runnable and touch only rows that need it, so the script can be stopped and
-- started again at any point.
--
-- "A USAspending row" everywhere below = award_uid NOT LIKE 'DIBBS%' AND source_url LIKE
-- 'https://www.usaspending.gov/award/%' (what the loader writes). DIBBS rows are never selected.
-- Idempotent: CREATE OR REPLACE. db/migrate.mjs wraps this file in one transaction (no begin/commit here).

-- The minimal raw for a stored raw. Keeps 'nsn' and 'cage' exactly as stored (value and JSON type), drops
-- every other key. A raw that is not a JSON object is returned unchanged.
CREATE OR REPLACE FUNCTION pub.usaspending_slim_raw(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN p
    ELSE (CASE WHEN p ? 'nsn'  THEN jsonb_build_object('nsn',  p -> 'nsn')  ELSE '{}'::jsonb END)
      || (CASE WHEN p ? 'cage' THEN jsonb_build_object('cage', p -> 'cage') ELSE '{}'::jsonb END)
  END
$$;

-- One id range of the cleanup, in the caller's transaction:
--   1. deletes USAspending rows dated before p_floor whose class is not in p_unfloored_classes
--      (rows with no action_date or no class are never deleted),
--   2. slims raw on the USAspending rows left in the range.
-- p_slim / p_delete switch the two steps off (the script uses that for dry runs of one step).
-- Returns how many rows each step touched. Row order inside a range is the primary key's.
CREATE OR REPLACE FUNCTION pub.usaspending_storage_cleanup_batch(
  p_from_id bigint,
  p_to_id bigint,
  p_floor date,
  p_unfloored_classes text[],
  p_delete boolean DEFAULT true,
  p_slim boolean DEFAULT true
) RETURNS TABLE (deleted bigint, slimmed bigint)
LANGUAGE plpgsql AS $$
DECLARE
  n_deleted bigint := 0;
  n_slimmed bigint := 0;
BEGIN
  IF p_delete AND p_floor IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pub.contract_actions ca
      WHERE ca.id BETWEEN p_from_id AND p_to_id
        AND ca.award_uid NOT LIKE 'DIBBS%'
        AND ca.source_url LIKE 'https://www.usaspending.gov/award/%'
        AND ca.action_date < p_floor
        AND ca.raw ->> 'nsn' IS NULL  -- a part-attached row is never deleted for its age
        AND ca.psc IS NOT NULL
        AND ca.psc::text <> ALL (COALESCE(p_unfloored_classes, ARRAY[]::text[]))
      RETURNING 1
    )
    SELECT count(*) INTO n_deleted FROM d;
  END IF;

  IF p_slim THEN
    WITH u AS (
      UPDATE pub.contract_actions ca
      SET raw = pub.usaspending_slim_raw(ca.raw)
      WHERE ca.id BETWEEN p_from_id AND p_to_id
        AND ca.award_uid NOT LIKE 'DIBBS%'
        AND ca.source_url LIKE 'https://www.usaspending.gov/award/%'
        AND ca.raw <> pub.usaspending_slim_raw(ca.raw)
      RETURNING 1
    )
    SELECT count(*) INTO n_slimmed FROM u;
  END IF;

  RETURN QUERY SELECT n_deleted, n_slimmed;
END
$$;

-- Maintenance helpers: not for the site's roles.
REVOKE ALL ON FUNCTION pub.usaspending_slim_raw(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pub.usaspending_storage_cleanup_batch(bigint, bigint, date, text[], boolean, boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION pub.usaspending_slim_raw(jsonb) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION pub.usaspending_storage_cleanup_batch(bigint, bigint, date, text[], boolean, boolean) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION pub.usaspending_slim_raw(jsonb) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION pub.usaspending_storage_cleanup_batch(bigint, bigint, date, text[], boolean, boolean) FROM authenticated';
  END IF;
END $$;

COMMENT ON FUNCTION pub.usaspending_slim_raw(jsonb) IS 'minimal raw of a USAspending contract action: nsn and cage only (migration 0021)';
COMMENT ON FUNCTION pub.usaspending_storage_cleanup_batch(bigint, bigint, date, text[], boolean, boolean) IS 'one id range of the USAspending history-floor delete and raw slimming; driven by db/usaspending-storage-cleanup.mjs (migration 0021)';
