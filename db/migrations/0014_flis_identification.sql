-- 0014 — FLIS identification data: item identification flags, standardization, cancelled-NIIN
-- links, every MOE rule row, the PUB LOG code dictionary and colloquial names (2026-11-14).
--
-- Written by ingest/publog/load-flis.mjs (nightly publog job) from files the job already
-- downloads: V_FLIS_IDENTIFICATION.CSV, V_FLIS_STANDARDIZATION.CSV, V_FLIS_CANCELLED_NIIN.CSV,
-- V_MOE_RULE.CSV, P_HELP.CSV, V_COLLOQUIAL_NAME.CSV. Enrich-only: per-NSN tables only get rows
-- for NSNs already in pub.nsns. Rows are upserted and never deleted, so an NSN that drops out
-- of the source keeps its last known row.
--
-- Grants: none, same as 0011. `pub` is not exposed through PostgREST and the site reads these
-- with the owner connection (build pool / Hyperdrive); the REVOKEs only guard against a project
-- whose default privileges hand new tables to anon / authenticated.
--
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

-- One row per NSN: V_FLIS_IDENTIFICATION.CSV (columns named as in the source in the comments).
CREATE TABLE IF NOT EXISTS pub.nsn_identification (
  nsn               char(13) PRIMARY KEY REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  inc               text,           -- INC  item name code
  crit_cd           text,           -- CRIT_CD  criticality code
  demil             text,           -- DMIL  demilitarization code
  demil_int_cd      text,           -- DMIL_INT_CD  demilitarization integrity code
  niin_assigned     date,           -- NIIN_ASGMT  date the NIIN was assigned
  pmic              text,           -- PMIC  precious metals indicator code
  adp               text,           -- ADP
  hmic              text,           -- HMIC  hazardous material indicator code
  esd_emi           text,           -- ESD_EMI
  hcc               text,           -- HCC  hazard characteristics code
  schedule_b        text,           -- SCHEDULE_B
  enac              text,           -- ENAC
  iuid_indicator    text,           -- IUID_INDICATOR
  last_known_sos    text,           -- LST_KWN_SOS  last known source of supply
  source_file_date  date,           -- date of the source file the row was read from (file mtime)
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pub.nsn_identification IS 'FLIS identification flags per NSN (INC, criticality, demil, precious metals, hazmat ...) from V_FLIS_IDENTIFICATION.CSV; enrich-only, never deleted.';

-- V_FLIS_STANDARDIZATION.CSV: related items and standardization decisions.
-- related_nsn is '' (not NULL) when the row has none so (nsn, related_nsn) can be the key.
CREATE TABLE IF NOT EXISTS pub.nsn_standardization (
  nsn             char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  related_nsn     text NOT NULL DEFAULT '',   -- RELATED_NSN, digits only as published
  isc             text,                       -- ISC
  orig_stdzn_dec  text,                       -- ORIG_STDZN_DEC
  stdzn_date      date,                       -- DT_STDZN_DEC
  niin_stat_cd    text,                       -- NIIN_STAT_CD
  PRIMARY KEY (nsn, related_nsn)
);
COMMENT ON TABLE pub.nsn_standardization IS 'FLIS standardization / related-NSN rows per NSN from V_FLIS_STANDARDIZATION.CSV; rows with only a status code are not loaded.';

-- V_FLIS_CANCELLED_NIIN.CSV. Columns keep their SOURCE names: which of niin / cancelled_niin is
-- the replaced item and which the replacement is not established from DLA documentation, so
-- do not read a direction into them. A row is kept when either NIIN is tracked; nsn is the
-- tracked NSN (the niin side when both are tracked), NULL if the NSN row is later removed.
CREATE TABLE IF NOT EXISTS pub.nsn_cancellations (
  niin                char(9) NOT NULL,       -- NIIN
  cancelled_niin_fsc  text,                   -- CANCELLED_NIIN_FSC
  cancelled_niin      char(9) NOT NULL,       -- CANCELLED_NIIN
  niin_stat_cd        text,                   -- NIIN_STAT_CD
  eff_date            date,                   -- EFF_DATE
  demil               text,                   -- DEMIL
  nsn                 char(13) REFERENCES pub.nsns(nsn) ON DELETE SET NULL,
  PRIMARY KEY (niin, cancelled_niin)
);
CREATE INDEX IF NOT EXISTS nsn_cancellations_cancelled_idx ON pub.nsn_cancellations (cancelled_niin);
CREATE INDEX IF NOT EXISTS nsn_cancellations_nsn_idx ON pub.nsn_cancellations (nsn) WHERE nsn IS NOT NULL;
COMMENT ON TABLE pub.nsn_cancellations IS 'Cancelled-NIIN links from V_FLIS_CANCELLED_NIIN.CSV involving a tracked NIIN on either side; column direction is as published, not interpreted.';

-- Every MOE rule row (one per managing service rule) for tracked NSNs. pub.amsc_observations
-- keeps only the single best AMC/AMSC; this keeps them all.
CREATE TABLE IF NOT EXISTS pub.moe_rules (
  nsn          char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  moe_rl       text NOT NULL,     -- MOE_RL  rule number / identifier
  moe_cd       text,              -- MOE_CD  (DS = DLA)
  amc          text,
  amsc         text,
  nimsc        text,
  assigned_on  date,              -- DT_ASGND
  imc          text,
  imca         text,
  aac          text,
  pica         text,
  pica_loa     text,
  sica         text,
  sica_loa     text,
  dsor         text,
  fmr_moe_rl   text,
  PRIMARY KEY (nsn, moe_rl)
);
COMMENT ON TABLE pub.moe_rules IS 'All MOE rule rows per NSN from V_MOE_RULE.CSV (acquisition / management codes per service); pub.amsc_observations holds only the best AMC/AMSC.';

-- P_HELP.CSV: the PUB LOG code dictionary (code -> literal, description, regulation link).
CREATE TABLE IF NOT EXISTS pub.flis_codes (
  code         text PRIMARY KEY,
  literal      text,
  description  text,
  regs         text
);
COMMENT ON TABLE pub.flis_codes IS 'PUB LOG code dictionary from P_HELP.CSV (AAC, AMC, AMSC, DEMIL ... definitions); loaded whole.';

-- V_COLLOQUIAL_NAME.CSV: everyday names for an item name code.
CREATE TABLE IF NOT EXISTS pub.inc_colloquial_names (
  inc              text NOT NULL,
  colloquial_name  text NOT NULL,
  PRIMARY KEY (inc, colloquial_name)
);
COMMENT ON TABLE pub.inc_colloquial_names IS 'Colloquial names per item name code (INC) from V_COLLOQUIAL_NAME.CSV; loaded whole.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['nsn_identification','nsn_standardization','nsn_cancellations','moe_rules','flis_codes','inc_colloquial_names'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON pub.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON pub.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
