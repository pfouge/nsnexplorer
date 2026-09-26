-- Government Parts Explorer — initial schema
-- Two schemas: `pub` (public-source data only; the site builds from this, read-only)
--              `ops` (private business engine; never touched by the site build)
-- Invariant: every row that can appear on a public page carries a NOT NULL source URL.

BEGIN;

CREATE SCHEMA IF NOT EXISTS pub;
CREATE SCHEMA IF NOT EXISTS ops;

-- ---------------------------------------------------------------------------
-- pub: reference
-- ---------------------------------------------------------------------------

CREATE TABLE pub.fsc (
  fsc            char(4) PRIMARY KEY,          -- Federal Supply Class, e.g. '5331'
  name           text NOT NULL,                -- 'O-Rings'
  fsg            char(2) GENERATED ALWAYS AS (substr(fsc, 1, 2)) STORED,
  render_depth   text NOT NULL DEFAULT 'shallow'
                 CHECK (render_depth IN ('deep', 'shallow', 'excluded'))
);

CREATE TABLE pub.agencies (
  agency_id      serial PRIMARY KEY,
  toptier_code   text,                         -- USAspending toptier agency code
  subtier_code   text,                         -- USAspending subtier code
  name           text NOT NULL,
  abbreviation   text,
  -- Identity: codes when the source provides them, name otherwise. Sources
  -- like the USAspending search API return names only, so name is part of
  -- the key (NULLS NOT DISTINCT keeps one row per code-less name).
  UNIQUE NULLS NOT DISTINCT (toptier_code, subtier_code, name)
);

CREATE TABLE pub.suppliers (
  cage           char(5) PRIMARY KEY,          -- CAGE code
  name           text,
  uei            text,                         -- SAM.gov Unique Entity ID
  city           text,
  state          text,
  country        text,
  sam_url        text,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- pub: the catalog
-- ---------------------------------------------------------------------------

CREATE TABLE pub.nsns (
  nsn            char(13) PRIMARY KEY,         -- digits only, e.g. '5331002915924'
  niin           char(9) GENERATED ALWAYS AS (substr(nsn, 5, 9)) STORED,
  fsc            char(4) NOT NULL REFERENCES pub.fsc(fsc),
  item_name      text,                         -- 'O-RING'
  characteristics jsonb,                       -- material, dimensions, spec refs (public FLIS data)
  hazmat         boolean,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pub.nsns (fsc);
CREATE INDEX ON pub.nsns (niin);

-- Manufacturer part-number cross reference (public catalog data only)
CREATE TABLE pub.part_numbers (
  id             bigserial PRIMARY KEY,
  nsn            char(13) NOT NULL REFERENCES pub.nsns(nsn),
  part_number    text NOT NULL,
  cage           char(5),                      -- referenced supplier may not exist yet
  source         text NOT NULL,                -- 'flis' | 'dibbs' | ...
  source_url     text NOT NULL,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nsn, part_number, cage)
);
CREATE INDEX ON pub.part_numbers (part_number);

-- AMSC/AMC as observed over time; the current value is the latest observation.
CREATE TABLE pub.amsc_observations (
  id             bigserial PRIMARY KEY,
  nsn            char(13) NOT NULL REFERENCES pub.nsns(nsn),
  amc            char(1),                      -- Acquisition Method Code
  amsc           char(1),                      -- Acquisition Method Suffix Code
  observed_on    date NOT NULL,
  source         text NOT NULL,                -- 'dibbs_rfq' | 'flis' | ...
  source_ref     text NOT NULL,                -- solicitation # or file id
  source_url     text NOT NULL,
  UNIQUE (nsn, observed_on, source, source_ref)
);
CREATE INDEX ON pub.amsc_observations (nsn, observed_on DESC);

-- ---------------------------------------------------------------------------
-- pub: what the government asked for and what it paid
-- ---------------------------------------------------------------------------

CREATE TABLE pub.solicitations (
  sol_number     text PRIMARY KEY,             -- e.g. 'SPE7M3-26-Q-0421'
  nsn            char(13) REFERENCES pub.nsns(nsn),
  quantity       numeric,
  unit_of_issue  text,
  issued_on      date,
  return_by      date,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'awarded', 'cancelled', 'expired', 'unknown')),
  amc            char(1),
  amsc           char(1),
  setaside       text,
  buyer_office   text,
  source_url     text NOT NULL,                -- DIBBS record URL
  raw            jsonb NOT NULL,               -- full parsed source record
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pub.solicitations (nsn);
CREATE INDEX ON pub.solicitations (status, return_by);

-- Unified price observations: one row = government paid $X/unit for NSN on a date.
-- THE table behind every price chart. source_url is the QA rule, enforced.
CREATE TABLE pub.price_points (
  id             bigserial PRIMARY KEY,
  nsn            char(13) NOT NULL REFERENCES pub.nsns(nsn),
  awarded_on     date NOT NULL,
  unit_price     numeric NOT NULL CHECK (unit_price >= 0),
  quantity       numeric,
  total_value    numeric,
  cage           char(5) REFERENCES pub.suppliers(cage),
  agency_id      int REFERENCES pub.agencies(agency_id),
  sol_number     text REFERENCES pub.solicitations(sol_number),
  award_ref      text NOT NULL,                -- contract/PIID or DIBBS award id
  source         text NOT NULL,                -- 'dibbs_award' | 'usaspending' | 'fpds'
  source_url     text NOT NULL,                -- link to the underlying government record
  raw            jsonb NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, award_ref, nsn, awarded_on)
);
CREATE INDEX ON pub.price_points (nsn, awarded_on);
CREATE INDEX ON pub.price_points (cage);

-- Agency-wide contract actions from USAspending/FPDS (context layer; usually no NSN).
CREATE TABLE pub.contract_actions (
  id             bigserial PRIMARY KEY,
  award_uid      text NOT NULL,                -- USAspending generated_unique_award_id
  piid           text,
  psc            char(4),
  naics          text,
  description    text,
  action_date    date,
  obligation     numeric,
  agency_id      int REFERENCES pub.agencies(agency_id),
  recipient_name text,
  recipient_uei  text,
  source_url     text NOT NULL,                -- usaspending.gov permalink
  raw            jsonb NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (award_uid, action_date)
);
CREATE INDEX ON pub.contract_actions (psc, action_date);

-- Email capture (public site, but not public data — still lives outside ops
-- because the site's form Worker writes here; contains PII, export only for sending)
CREATE TABLE pub.signups (
  id             bigserial PRIMARY KEY,
  email          text NOT NULL,
  hook           text NOT NULL CHECK (hook IN ('shop_alerts', 'overpay_digest')),
  fsc_interest   char(4)[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, hook)
);

-- ---------------------------------------------------------------------------
-- ops: the private business engine (never read by the site build)
-- ---------------------------------------------------------------------------

CREATE TABLE ops.partner_shops (
  shop_id        serial PRIMARY KEY,
  name           text NOT NULL,
  location       text,
  cage           char(5),
  capabilities   jsonb,                        -- processes, materials, size envelope, certs
  contact        jsonb,
  status         text NOT NULL DEFAULT 'prospect'
                 CHECK (status IN ('prospect', 'in_discussion', 'active', 'inactive')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.targets (
  nsn            char(13) PRIMARY KEY REFERENCES pub.nsns(nsn),
  track          text NOT NULL CHECK (track IN ('quoter', 'challenger')),
  score          numeric NOT NULL,
  score_components jsonb NOT NULL,             -- each factor 0-1 + weights used
  scored_at      timestamptz NOT NULL,
  scoring_version text NOT NULL,
  status         text NOT NULL DEFAULT 'candidate'
                 CHECK (status IN ('candidate', 'shortlist', 'active', 'dropped')),
  notes          text
);
CREATE INDEX ON ops.targets (track, score DESC);

CREATE TABLE ops.quotes (
  quote_id       bigserial PRIMARY KEY,
  sol_number     text NOT NULL REFERENCES pub.solicitations(sol_number),
  nsn            char(13) REFERENCES pub.nsns(nsn),
  our_unit_price numeric,
  supplier_cost  numeric,
  margin_pct     numeric,
  winnability    numeric,                      -- quoter score at time of quote
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'reviewed', 'submitted', 'won', 'lost',
                                   'no_bid', 'cancelled')),
  submitted_at   timestamptz,
  decided_at     timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ops.quotes (status);

CREATE TABLE ops.sar_cases (
  sar_id         serial PRIMARY KEY,
  nsn            char(13) NOT NULL REFERENCES pub.nsns(nsn),
  shop_id        int REFERENCES ops.partner_shops(shop_id),
  stage          text NOT NULL DEFAULT 'identified'
                 CHECK (stage IN ('identified', 'shop_matched', 'sample_requested',
                                  'sample_received', 'package_assembly', 'submitted',
                                  'approved', 'rejected', 'withdrawn')),
  -- Compliance: this row holds status only. Technical data lives US-side, never here.
  us_custodian   text,                         -- the JCP-certified US person responsible
  stage_dates    jsonb NOT NULL DEFAULT '{}',  -- stage -> date
  submitted_on   date,
  decided_on     date,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.inbound_inquiries (
  id             bigserial PRIMARY KEY,
  source         text NOT NULL,                -- 'site_form' | 'email' | 'press' | ...
  from_name      text,
  from_email     text,
  kind           text CHECK (kind IN ('shop', 'press', 'buyer', 'other')),
  body           text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  handled        boolean NOT NULL DEFAULT false
);

-- Weekly magnet metrics for the kill criteria
CREATE TABLE ops.magnet_metrics (
  week_start     date PRIMARY KEY,
  press_citations int NOT NULL DEFAULT 0,
  organic_visits  int,
  shop_signups    int NOT NULL DEFAULT 0,
  inbound_inquiries int NOT NULL DEFAULT 0,
  notes          text
);

-- ---------------------------------------------------------------------------
-- Roles: the site build can only ever see pub
-- ---------------------------------------------------------------------------
-- Run once per environment (kept here as documentation; CI applies it):
--   CREATE ROLE site_build LOGIN PASSWORD :'SITE_BUILD_PW';
--   GRANT USAGE ON SCHEMA pub TO site_build;
--   GRANT SELECT ON ALL TABLES IN SCHEMA pub TO site_build;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA pub GRANT SELECT ON TABLES TO site_build;
--   REVOKE ALL ON SCHEMA ops FROM site_build;

COMMIT;
