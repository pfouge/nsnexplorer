-- 0013 — One history ledger for every date-based source (2026-10-13).
--
-- Replaces ops.dibbs_award_dates (0012, one day old). Each row is one period of one lane: a DIBBS
-- posting date, a SAM.gov posting date, or a USAspending month for one class. It records what the
-- source said exists (`expected`, e.g. DIBBS's "Records Found"), what we parsed (`records`) and
-- loaded, and whether the read was complete. Written by ingest/ledger.mjs callers:
--   dibbs_awd        ingest/dibbs/dibbs-dates.mjs --grid awd   (ingest-daily)
--   dibbs_rfq        ingest/dibbs/dibbs-dates.mjs --grid rfq   (rfq-fast)
--   sam              ingest/sam/backfill.mjs                    (sam-daily)
--   usaspending_<fsc> ingest/usaspending/backfill.mjs           (ingest-daily, one month per row)
--
-- Every run reads the newest periods and then walks back through periods that are missing or
-- incomplete, a few per run. That heals data loaded before the ledger existed (it has no row, so
-- it counts as unverified and is re-read) and then extends history until the source runs out.
--
-- The rows 0012 wrote are carried over as unverified (complete = false), so they are re-read once
-- with the completeness check.
--
-- Operational table: lives in `ops`, never read by the site except through db/freshness.mjs.
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

CREATE TABLE IF NOT EXISTS ops.source_dates (
  lane             text NOT NULL,
  day              date NOT NULL,
  expected         integer,
  records          integer NOT NULL,
  pages            integer NOT NULL DEFAULT 0,
  loaded           integer NOT NULL DEFAULT 0,
  extra            integer NOT NULL DEFAULT 0,
  complete         boolean NOT NULL DEFAULT false,
  fetches          integer NOT NULL DEFAULT 1,
  records_changed  boolean NOT NULL DEFAULT false,
  first_fetched_at timestamptz NOT NULL DEFAULT now(),
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lane, day)
);

COMMENT ON COLUMN ops.source_dates.extra IS 'lane-specific second count: price points (dibbs_awd), price points re-joined (dibbs_rfq), new rows inserted (usaspending_*)';

DO $$
BEGIN
  IF to_regclass('ops.dibbs_award_dates') IS NOT NULL THEN
    INSERT INTO ops.source_dates (lane, day, expected, records, pages, loaded, extra, complete, fetches,
                                  records_changed, first_fetched_at, fetched_at)
    SELECT 'dibbs_awd', day, NULL, records, pages, loaded, price_points, false, fetches,
           records_changed, first_fetched_at, fetched_at
      FROM ops.dibbs_award_dates
    ON CONFLICT (lane, day) DO NOTHING;
    DROP TABLE ops.dibbs_award_dates;
  END IF;
END $$;

REVOKE ALL ON ops.source_dates FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ops.source_dates FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ops.source_dates FROM authenticated';
  END IF;
END $$;
