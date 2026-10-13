-- 0012 — Which DIBBS award posting dates have been loaded, and when (2026-10-13).
--
-- Written by ingest/dibbs/awards-daily.mjs (ingest-daily, job `dibbs`). The job used to re-fetch
-- the last 7 business days in full every day (~550 pages at ~23 s a page on DIBBS) and only load
-- after the whole crawl, so it hit its 2h30 limit on 5 of 10 days (2026-10-05..12) and lost the
-- lot. With this table it fetches a date until it has been read at least two days after it was
-- posted ("settled"), loads each date as soon as it is fetched, and skips settled dates.
--
-- One row per posting date. `fetches` counts reads; `records_changed` is set when a re-read found
-- a different record count than the read before it (evidence for whether re-reads are worth it).
--
-- Operational table: lives in `ops`, never read by the site.
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

CREATE TABLE IF NOT EXISTS ops.dibbs_award_dates (
  day              date PRIMARY KEY,
  pages            integer NOT NULL,
  records          integer NOT NULL,
  loaded           integer NOT NULL,
  price_points     integer NOT NULL DEFAULT 0,
  fetches          integer NOT NULL DEFAULT 1,
  records_changed  boolean NOT NULL DEFAULT false,
  first_fetched_at timestamptz NOT NULL DEFAULT now(),
  fetched_at       timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ops.dibbs_award_dates FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ops.dibbs_award_dates FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ops.dibbs_award_dates FROM authenticated';
  END IF;
END $$;
