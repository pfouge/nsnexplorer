-- 0020 — PUB LOG "management" data per NSN: the government's standard unit price, unit of issue, shelf
-- life code and related supply-management codes (2026-11-15).
--
-- Written by ingest/publog/load-management.mjs (nightly publog job) from the files in DLA's
-- MANAGEMENT.zip: V_FLIS_MANAGEMENT.CSV (source 'FLIS') and the per-service V_MGMT_<SERVICE>.CSV files
-- (source 'ARMY', 'NAVY', 'AIR_FORCE', 'MARINE_CORPS', 'COAST_GUARD'). Enrich-only: rows only for NSNs already
-- in pub.nsns. Upserts only, never deleted, so an NSN keeps its last known row if it drops out of the source.
--
-- Key: (nsn, source, moe_cd). `source` says which file the row came from; `moe_cd` is the row's own MOE /
-- service code when the file carries one and '' otherwise (it is NOT NULL so it can be part of the key).
-- Codes are stored exactly as published (trimmed); labels come from pub.flis_codes at read time.
-- unit_price_raw keeps the published text of the price so a parsing assumption can be checked after the
-- first production load. `extra` holds every other non-blank column of the source row (column name -> text)
-- so nothing the file carries is lost while its layout is being confirmed.
--
-- Grants: none, same as 0011 / 0014. `pub` is not exposed through PostgREST.
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

CREATE TABLE IF NOT EXISTS pub.nsn_management (
  nsn              char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  source           text NOT NULL,               -- 'FLIS' or the service named by the file (V_MGMT_ARMY.CSV -> 'ARMY')
  moe_cd           text NOT NULL DEFAULT '',    -- MOE / service code carried by the row; '' when the file has none
  effective_date   date,                        -- effective date of the management data
  aac              text,                        -- AAC  acquisition advice code
  sos              text,                        -- SOS  source of supply
  ui               text,                        -- UI   unit of issue
  unit_price       numeric,                     -- unit price in US dollars as published (0 and NULL both mean "no price")
  unit_price_raw   text,                        -- the published price text, unmodified
  qup              text,                        -- QUP  quantity per unit pack
  ciic             text,                        -- CIIC controlled inventory item code
  slc              text,                        -- SLC  shelf life code
  repairability    text,                        -- repairability / recoverability code
  extra            jsonb,                       -- other non-blank source columns, name -> text
  source_file_date date,                        -- date of the source file the row was read from (file mtime)
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nsn, source, moe_cd)
);
CREATE INDEX IF NOT EXISTS nsn_management_slc_idx ON pub.nsn_management (slc) WHERE slc IS NOT NULL;
CREATE INDEX IF NOT EXISTS nsn_management_sos_idx ON pub.nsn_management (sos) WHERE sos IS NOT NULL;
CREATE INDEX IF NOT EXISTS nsn_management_priced_idx ON pub.nsn_management (nsn) WHERE unit_price > 0;
COMMENT ON TABLE pub.nsn_management IS 'PUB LOG management data per NSN (standard unit price, unit of issue, shelf life code, source of supply, AAC, CIIC ...) from MANAGEMENT.zip; one row per source file and MOE code; enrich-only, never deleted. The unit price is the government catalog price, not an award price.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON pub.nsn_management FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON pub.nsn_management FROM authenticated;
  END IF;
END $$;
