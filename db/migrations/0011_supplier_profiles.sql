-- 0011 — Supplier profiles: SAM.gov entity record, the company's own website, precomputed
-- totals/ranks for the /supplier/ leaderboard, and a removal (opt-out) list (2026-10-11).
--
-- Written by ingest/sam-entities (supplier_sam, monthly), ingest/supplier-web (supplier_web,
-- daily) and db/refresh-supplier-stats.mjs (supplier_stats, daily + every deploy). Read by the
-- /supplier/ leaderboard (build time) and /supplier/<CAGE>/ (one Hyperdrive statement).
--
-- Grants: none. 0009 gave `authenticated` select on the public record tables the watchlist feed
-- reads; these tables are not part of the feed, `pub` is not exposed through PostgREST, and the
-- site reads them with the owner connection (build pool / Hyperdrive). The REVOKEs below only
-- guard against a project whose default privileges hand new tables to anon / authenticated.
--
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

-- SAM.gov public entity record per CAGE (public tier only; refreshed monthly).
CREATE TABLE IF NOT EXISTS pub.supplier_sam (
  cage              char(5) PRIMARY KEY REFERENCES pub.suppliers(cage) ON DELETE CASCADE,
  uei               text,
  legal_name        text,
  dba_name          text,
  entity_url        text,            -- as registered, normalised to https?://host/...
  phys_line1 text, phys_line2 text, phys_city text, phys_state text, phys_zip text, phys_zip4 text, phys_country text,
  mail_line1 text, mail_line2 text, mail_city text, mail_state text, mail_zip text, mail_zip4 text, mail_country text,
  registration_status text,          -- 'Active' | 'Inactive' | ...
  registration_date   date,
  expiration_date     date,
  last_update_date    date,
  activation_date     date,
  entity_start_date   date,          -- business start date
  entity_structure    text,          -- e.g. 'Corporate Entity (Not Tax Exempt)'
  state_of_incorporation text,
  business_types      text[] NOT NULL DEFAULT '{}',   -- human labels
  sba_certifications  jsonb  NOT NULL DEFAULT '[]',   -- [{"label":"8(a)","entry":"2021-01-01","exit":"2030-01-01"}]
  primary_naics       text,
  naics               jsonb  NOT NULL DEFAULT '[]',   -- [{"code":"332722","small":true}]
  psc                 text[] NOT NULL DEFAULT '{}',
  pocs                jsonb  NOT NULL DEFAULT '[]',   -- [{"role":"Government Business POC","name":"Jane Doe","title":"President"}]  names/titles ONLY
  source_file         text NOT NULL,                  -- extract file name
  synced_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_sam_uei ON pub.supplier_sam (uei) WHERE uei IS NOT NULL;

-- What the company says about itself on its own website (refreshed ~every 180 days).
CREATE TABLE IF NOT EXISTS pub.supplier_web (
  cage            char(5) PRIMARY KEY REFERENCES pub.suppliers(cage) ON DELETE CASCADE,
  url             text NOT NULL,      -- start URL (from supplier_sam.entity_url)
  final_url       text,               -- after redirects
  status          text NOT NULL CHECK (status IN ('ok','ok_no_ai','robots_blocked','unreachable','no_text','error')),
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  pages           jsonb NOT NULL DEFAULT '[]',        -- [{"url":"...","title":"..."}] pages actually read (max 4)
  summary         text,               -- <= 90 words, neutral, third person, our words
  products        text[] NOT NULL DEFAULT '{}',
  capabilities    text[] NOT NULL DEFAULT '{}',
  certifications  text[] NOT NULL DEFAULT '{}',
  founded         int CHECK (founded IS NULL OR founded BETWEEN 1700 AND 2100),
  phone           text,               -- as published on their site
  email           text,               -- as published on their site (prefer role mailboxes: info@, sales@, ...)
  contact_url     text,               -- page the phone/email came from
  meta_description text,              -- the site's own <meta name=description>, kept for the no-AI fallback
  model           text,               -- e.g. 'claude-haiku-4-5' or NULL
  error           text
);
CREATE INDEX IF NOT EXISTS supplier_web_fetched_at ON pub.supplier_web (fetched_at);

-- Precomputed totals and ranks (refreshed daily; read by the leaderboard build and the supplier page query).
CREATE TABLE IF NOT EXISTS pub.supplier_stats (
  cage              char(5) PRIMARY KEY REFERENCES pub.suppliers(cage) ON DELETE CASCADE,
  awards_all        int NOT NULL,
  dollars_all       numeric NOT NULL,
  awards_12m        int NOT NULL,
  dollars_12m       numeric NOT NULL,
  awards_prior_12m  int NOT NULL,
  dollars_prior_12m numeric NOT NULL,
  nsns              int NOT NULL,
  fscs              int NOT NULL,
  agencies          int NOT NULL,
  first_award       date NOT NULL,
  last_award        date NOT NULL,
  rank_dollars_12m  int, rank_dollars_all int, rank_wins_12m int, rank_wins_all int,
  rank_nsns int, rank_fscs int, rank_rising int,
  rising_delta      numeric,          -- dollars_12m - dollars_prior_12m
  refreshed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_dollars_12m  ON pub.supplier_stats (rank_dollars_12m);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_dollars_all  ON pub.supplier_stats (rank_dollars_all);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_wins_12m     ON pub.supplier_stats (rank_wins_12m);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_wins_all     ON pub.supplier_stats (rank_wins_all);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_nsns         ON pub.supplier_stats (rank_nsns);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_fscs         ON pub.supplier_stats (rank_fscs);
CREATE INDEX IF NOT EXISTS supplier_stats_rank_rising       ON pub.supplier_stats (rank_rising);

-- Suppliers who asked us to remove contact details / web profile. Checked by the page query.
-- No foreign key on purpose: a removal request must survive the supplier row being rebuilt.
CREATE TABLE IF NOT EXISTS pub.supplier_optouts (
  cage        char(5) PRIMARY KEY,
  hide_contact boolean NOT NULL DEFAULT true,   -- street address, mailing address, POCs, phone, email
  hide_web     boolean NOT NULL DEFAULT true,   -- AI profile
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON pub.supplier_sam, pub.supplier_web, pub.supplier_stats, pub.supplier_optouts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON pub.supplier_sam, pub.supplier_web, pub.supplier_stats, pub.supplier_optouts FROM authenticated;
  END IF;
END $$;

-- pub.refresh_supplier_stats(): rebuilds pub.supplier_stats from pub.price_points as of CURRENT_DATE
-- in one TRUNCATE + INSERT ... SELECT, inside the caller's transaction (readers see the old rows
-- until it commits, then the new ones; nothing ever reads a half-built table). Returns the row count.
--
--   award value   recorded total_value, else unit_price * quantity, else nothing (same rule as
--                 web/src/lib/supplier-page.ts VALUE_SQL)
--   12m           awarded_on >  CURRENT_DATE - 365
--   prior 12m     awarded_on >  CURRENT_DATE - 730 AND awarded_on <= CURRENT_DATE - 365
--   ranks         1 = best; metric DESC, ties broken by cage ASC in C collation (every rank is unique);
--                 NULL when the metric is 0
--   rank_rising   rising_delta DESC among suppliers with dollars_12m >= 10000 AND awards_12m >= 3;
--                 NULL for everyone else
--   eligibility   CAGEs with at least one price_point (the same set that has a /supplier/ page)
CREATE OR REPLACE FUNCTION pub.refresh_supplier_stats() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  TRUNCATE pub.supplier_stats;

  INSERT INTO pub.supplier_stats (
    cage, awards_all, dollars_all, awards_12m, dollars_12m, awards_prior_12m, dollars_prior_12m,
    nsns, fscs, agencies, first_award, last_award,
    rank_dollars_12m, rank_dollars_all, rank_wins_12m, rank_wins_all, rank_nsns, rank_fscs, rank_rising,
    rising_delta, refreshed_at)
  WITH agg AS (
    SELECT pp.cage,
           count(*)::int                                              AS awards_all,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity)), 0) AS dollars_all,
           (count(*) FILTER (WHERE pp.awarded_on > CURRENT_DATE - 365))::int AS awards_12m,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity))
                    FILTER (WHERE pp.awarded_on > CURRENT_DATE - 365), 0) AS dollars_12m,
           (count(*) FILTER (WHERE pp.awarded_on > CURRENT_DATE - 730
                               AND pp.awarded_on <= CURRENT_DATE - 365))::int AS awards_prior_12m,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity))
                    FILTER (WHERE pp.awarded_on > CURRENT_DATE - 730
                              AND pp.awarded_on <= CURRENT_DATE - 365), 0) AS dollars_prior_12m,
           count(DISTINCT pp.nsn)::int                                AS nsns,
           count(DISTINCT n.fsc)::int                                 AS fscs,
           count(DISTINCT pp.agency_id)::int                          AS agencies,
           min(pp.awarded_on)                                         AS first_award,
           max(pp.awarded_on)                                         AS last_award
    FROM pub.price_points pp
    JOIN pub.nsns n ON n.nsn = pp.nsn
    WHERE pp.cage IS NOT NULL
    GROUP BY pp.cage
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
         d.rising_delta, now()
  FROM delta d;
  -- A metric of 0 sorts last, so ranking every row and blanking the zeros leaves 1..k on the rest.
  -- rank_rising ranks inside its own partition (the qualifying suppliers), so non-qualifying
  -- suppliers never take a position.
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
