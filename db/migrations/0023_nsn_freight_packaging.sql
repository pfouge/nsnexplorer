-- 0023: PUB LOG freight and packaging data per NSN (2026-11-16).
--
-- Written by ingest/publog/load-freight-packaging.mjs (nightly publog job) from DLA's FREIGHT_PACKAGING.zip:
--   V_FLIS_PACKAGING_1.CSV, V_FLIS_PACKAGING_2.CSV, V_FLIS_PACKAGING_3.CSV -> pub.nsn_packaging (one merged row
--     per NSN and PICA/SICA; the three files are merged in memory and written once, with only the columns of
--     the files that loaded)
--   V_FREIGHT.CSV                                                         -> pub.nsn_freight
--   V_DSS_WEIGHT_AND_CUBE.CSV (in DLA's layout document, not in the zip as of 2026-11) -> pub.nsn_dss_weight_cube
-- Enrich-only: rows only for NSNs already in pub.nsns. Upserts only, never deleted, so an NSN keeps its last
-- known row if it drops out of the source.
--
-- There is no source_file_date column on purpose: it would change every month and force a rewrite of every row.
-- Rows are rewritten only when a published value changes; updated_at moves only then.
--
-- Column names are the source header names in lower case. Codes are stored exactly as published (trimmed);
-- placeholders such as 'ZZ' and '00' are kept as published. Numeric columns hold NULL where the file says 0
-- (zero means "not recorded" in these files). Units are not stated in the files: by DoD packaging convention
-- weights are pounds, dimensions inches and cube cubic feet.
-- No secondary indexes on purpose: pages read by nsn through the primary key, and the database has a size limit.
--
-- Grants: none, same as 0011 / 0014 / 0020. `pub` is not exposed through PostgREST.
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

CREATE TABLE IF NOT EXISTS pub.nsn_packaging (
  nsn                       char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  pica_sica                 text NOT NULL DEFAULT '',  -- P (primary inventory control activity) or S (secondary); '' if blank
  -- from V_FLIS_PACKAGING_1.CSV
  pkg_cat                   text,        -- PKG_CAT packaging category code
  unpkg_item_weight         numeric,     -- UNPKG_ITEM_WEIGHT unpackaged item weight (pounds by DoD convention, not stated in the file); NULL when the file says 0
  unpkg_item_width          numeric,     -- UNPKG_ITEM_WIDTH unpackaged item width (inches by convention, not stated in the file); NULL when 0
  unpkg_item_length         numeric,     -- UNPKG_ITEM_LENGTH unpackaged item length (inches by convention, not stated in the file); NULL when 0
  unpkg_item_height         numeric,     -- UNPKG_ITEM_HEIGHT unpackaged item height (inches by convention, not stated in the file); NULL when 0
  ui                        text,        -- UI unit of issue
  tos                       text,        -- TOS item type storage code
  icq                       text,        -- ICQ intermediate container quantity
  mop                       text,        -- MOP method of preservation
  clng_drying               text,        -- CLNG_DRYING cleaning and drying procedure
  pres_mat                  text,        -- PRES_MAT preservation material
  wrap_mat                  text,        -- WRAP_MAT wrapping material
  cush_dun                  text,        -- CUSH_DUN cushioning and dunnage material
  thk                       text,        -- THK thickness of cushioning or dunnage
  unit_cont                 text,        -- UNIT_CONT unit container
  pkg_data_source           text,        -- PKG_DATA_SOURCE source of the packaging data
  -- from V_FLIS_PACKAGING_2.CSV
  spc_mkg                   text,        -- SPC_MKG special marking
  inter_cont                text,        -- INTER_CONT intermediate container
  ucl                       text,        -- UCL unit container level
  lvl_a                     text,        -- LVL_A packing requirement code, level A
  lvl_b                     text,        -- LVL_B packing requirement code, level B
  lvl_c                     text,        -- LVL_C packing requirement code, level C
  unit_pack_weight          numeric,     -- UNIT_PACK_WEIGHT unit pack weight (pounds by convention, not stated in the file); NULL when 0
  up_sz_maxb                numeric,     -- UP_SZ_MAXB unit pack size, breadth (inches by convention, not stated in the file); NULL when 0
  up_sz_maxl                numeric,     -- UP_SZ_MAXL unit pack size, length (inches by convention, not stated in the file); NULL when 0
  up_sz_maxh                numeric,     -- UP_SZ_MAXH unit pack size, height (inches by convention, not stated in the file); NULL when 0
  unit_pack_cube            numeric,     -- UNIT_PACK_CUBE unit pack cube (cubic feet by convention, not stated in the file); NULL when 0
  opi                       text,        -- OPI optional procedure indicator
  supplemental_instructions text,        -- SUPPLEMENTAL_INSTRUCTIONS free-text packaging instructions
  -- from V_FLIS_PACKAGING_3.CSV
  pkg_design_acty           text,        -- PKG_DESIGN_ACTY packaging design activity
  spi_no                    text,        -- SPI_NO special packaging instruction number
  spi_rev                   text,        -- SPI_REV special packaging instruction revision
  spi_date                  text,        -- SPI_DATE as published (looks like a 5-digit YYDDD Julian date; not parsed); NULL when 00000
  cont_nsn                  text,        -- CONT_NSN NSN of the container
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nsn, pica_sica)
);
COMMENT ON TABLE pub.nsn_packaging IS 'PUB LOG packaging data per NSN and PICA/SICA (preservation, packing levels, unit pack weight and size, special packaging instruction) merged from V_FLIS_PACKAGING_1/2/3.CSV in FREIGHT_PACKAGING.zip; enrich-only, never deleted. Units are not stated in the files (pounds, inches, cubic feet by convention).';

CREATE TABLE IF NOT EXISTS pub.nsn_freight (
  nsn                       char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  acty_cd                   text,        -- ACTY_CD activity code (the code dictionary calls it major organizational entity)
  nmfc                      text,        -- NMFC National Motor Freight Classification item number
  nmfc_sub                  text,        -- NMFC_SUB NMFC sub-item number
  ufc                       text,        -- UFC Uniform Freight Classification item number
  hmc                       text,        -- HMC hazardous material code
  ltl                       text,        -- LTL National Motor Freight class rating code
  lcl                       text,        -- LCL less than car load rating code
  rvc                       text,        -- RVC rail variation code
  wcc                       text,        -- WCC water commodity code
  tcc                       text,        -- TCC type of cargo code
  shc                       text,        -- SHC special handling code
  adc                       text,        -- ADC as published (no definition in the code dictionary)
  acc                       text,        -- ACC air commodity code
  integ                     text,        -- INTEG integrity code
  nmf_desc                  text,        -- NMF_DESC freight description
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nsn)
);
COMMENT ON TABLE pub.nsn_freight IS 'PUB LOG freight classification per NSN (NMFC, UFC, hazardous material code, LTL/LCL ratings, transportation codes, freight description) from V_FREIGHT.CSV in FREIGHT_PACKAGING.zip; one row per NSN; enrich-only, never deleted.';

-- Header of V_DSS_WEIGHT_AND_CUBE.CSV (NIIN, DSS_WEIGHT, DSS_CUBE) is from DLA's layout document and unverified.
CREATE TABLE IF NOT EXISTS pub.nsn_dss_weight_cube (
  nsn                       char(13) NOT NULL REFERENCES pub.nsns(nsn) ON DELETE CASCADE,
  dss_weight                numeric,                   -- DSS_WEIGHT (pounds by convention, not stated in the file); NULL when 0
  dss_cube                  numeric,                   -- DSS_CUBE (cubic feet by convention, not stated in the file); NULL when 0
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (nsn)
);
COMMENT ON TABLE pub.nsn_dss_weight_cube IS 'PUB LOG DSS weight and cube per NSN from V_DSS_WEIGHT_AND_CUBE.CSV (listed in DLA''s layout, not in FREIGHT_PACKAGING.zip as of 2026-11); enrich-only, never deleted.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON pub.nsn_packaging FROM anon;
    REVOKE ALL ON pub.nsn_freight FROM anon;
    REVOKE ALL ON pub.nsn_dss_weight_cube FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON pub.nsn_packaging FROM authenticated;
    REVOKE ALL ON pub.nsn_freight FROM authenticated;
    REVOKE ALL ON pub.nsn_dss_weight_cube FROM authenticated;
  END IF;
END $$;
