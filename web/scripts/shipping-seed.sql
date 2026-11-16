-- Synthetic PUB LOG freight and packaging rows (migration 0023) for LOCAL checks only: web/scripts/verify-single-query.mjs --seed.
-- Applied ONLY to the throw-away clone, after verify-single-query-seed.sql (which creates the 7340xxxxxxxxx NSNs). Never run
-- against a real database. Deterministic. The values come from real rows of the PUB LOG files (NIINs 000182463, 000000050,
-- 000000121, 000000048) and are placed on seeded NSNs; the dictionary rows are the real ones where known, plausible
-- literals where the real text is not known here (TCC:Z, TCC:R, SHC:9, SHC:D, MOP:10 description).
--
-- Cases (rn = position among the seeded FSC 7340 NSNs ordered by nsn; flis-seed.sql uses FSC 7330, mgmt-seed.sql too):
--   rn 1  packaging only (one P row): blank category, placeholder-literal codes, a supplemental instruction, no sizes
--   rn 2  freight only: hazardous material code blank ("None on file"), LTL W, cargo and handling codes
--   rn 3  richest part: P row (every field) AND an S row with different values (the P row must win) plus a freight row
--         with a decoded hazardous material code and a numeric LTL class
--   rn 4  very long supplemental instructions and SPI number with no spaces (overflow test) plus freight with no
--         freight description and a special handling code that has NO dictionary row
--   rn 5  neither (no packaging, no freight)
--   rn 6  an S row only (no P row), category decoded from a NUMERIC-POSITIONS literal, LTL K (numeric) and Z (no rating)
--   rn 7  codes with no dictionary row at all (category 9Q.., MOP GX, packing levels, LTL Q, cargo R is seeded, cargo X is not)

DELETE FROM pub.nsn_packaging WHERE nsn IN (SELECT nsn FROM pub.nsns WHERE fsc = '7340');
DELETE FROM pub.nsn_freight WHERE nsn IN (SELECT nsn FROM pub.nsns WHERE fsc = '7340');
DELETE FROM pub.flis_codes WHERE code IN (
  'SPC_MKG:00', 'SPC_MKG:01', 'SPC_MKG:39', 'SPC_MKG:ZZ', 'UCL:A', 'UCL:O', 'LVL_A:Q', 'LVL_A:E', 'LVL_B:Q', 'LVL_B:F', 'MOP:10', 'MOP:31',
  'LTL:M', 'LTL:J', 'LTL:K', 'LTL:W', 'LTL:Z', 'HMC:AA', 'TCC:1', 'TCC:3', 'TCC:Z', 'TCC:R', 'SHC:9', 'SHC:D',
  'PKG_CAT:27', 'PKG_CAT:69', 'PKG_CAT:ZZ', 'PKG_CAT:01');

CREATE TEMP TABLE ship_seed_nsns AS
  SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn FROM pub.nsns WHERE fsc = '7340';

INSERT INTO pub.flis_codes (code, literal, description) VALUES
  ('SPC_MKG:00', 'NUMERIC', 'NO SPECIAL MARKING.'),
  ('SPC_MKG:01', 'NUMERIC', 'FRAGILE.'),
  ('SPC_MKG:39', 'ESD SENSITIVE', 'ESD SENSITIVE ELECTRONIC DEVICE REQUIREMENTS OF MIL-STD-129 APPLY.'),
  ('SPC_MKG:ZZ', 'SPECIAL REQUIREMENTS', 'SPECIAL REQUIREMENTS.'),
  ('UCL:A', 'LEVEL A PACKING PROTECTION', 'UNIT CONTAINER PROVIDES LEVEL A PACKING PROTECTION.'),
  ('UCL:O', 'NOT AN ACCEPTABLE SHIPPING CONTAINER', 'UNIT CONTAINER IS NOT AN ACCEPTABLE SHIPPING CONTAINER.'),
  ('LVL_A:Q', 'TABLE C.II', 'PACKING SHALL BE ACCOMPLISHED IN ACCORDANCE WITH TABLE C.II FOR THE PACKING LEVEL SPECIFIED. CLOSURE, SEALING AND REINFORCEMENT ...'),
  ('LVL_A:E', 'REQUIREMENTS OF ASTM-D4169', 'PACKING SHALL BE ACCOMPLISHED TO MEET THE PERFORMANCE TEST REQUIREMENTS OF ASTM-D4169, DISTRIBUTION CYCLE 18, ...'),
  ('LVL_B:Q', 'TABLE C.II', 'PACKING SHALL BE ACCOMPLISHED IN ACCORDANCE WITH TABLE C.II FOR THE PACKING LEVEL SPECIFIED. CLOSURE, SEALING AND REINFORCEMENT ...'),
  ('LVL_B:F', 'PACKING IS NOT REQUIRED', 'PACKING IS NOT REQUIRED. THE UNIT CONTAINER SHALL ALSO SERVE AS THE SHIPPING CONTAINER. ...'),
  ('MOP:10', 'NUMERIC', 'PHYSICAL PROTECTION.'),
  ('MOP:31', 'WATERPROOF BAG SEALED', 'WATERPROOF BAG SEALED.'),
  ('LTL:M', '85.0', '85.0'),
  ('LTL:J', '100.0', '100.0'),
  ('LTL:K', '92.5', '92.5'),
  ('LTL:W', 'RATING VARIABLE', 'RATING VARIABLE'),
  ('LTL:Z', 'NO RATING', 'NO RATING'),
  ('HMC:AA', 'AMMUNITION FOR CANNON WITH EMPTY PROJECT', 'AMMUNITION FOR CANNON WITH EMPTY PROJECT'),
  ('TCC:1', 'AIRCRAFT ENGINE', 'AIRCRAFT ENGINE'),
  ('TCC:3', 'ELECTROSTATIC SENSITIVE DEVICE', 'ELECTROSTATIC SENSITIVE DEVICE'),
  ('TCC:Z', 'GENERAL FREIGHT', 'GENERAL FREIGHT'),
  ('TCC:R', 'REFRIGERATED', 'REFRIGERATED'),
  ('SHC:9', 'NO SPECIAL HANDLING', 'NO SPECIAL HANDLING'),
  ('SHC:D', 'KEEP DRY', 'KEEP DRY'),
  ('PKG_CAT:27', 'POSITIONS 1 AND 2', 'PLATED COATED ITEMS. NON-FERROUS METALS THAT HAVE BEEN PLATED. METHOD OF PRESERVATION 10. IF COMBINED WITH A N...'),
  ('PKG_CAT:69', 'POSITIONS 1 AND 2', 'RADIO AND RADAR, OTHER COMMUNICATIONS EQUIPMENT, ELECTRONIC ASSEMBLIES, SUBASSEMBLIES AND COMPONENT PARTS (NOT...'),
  ('PKG_CAT:ZZ', 'POSITIONS 1 AND 2', 'NONE OF THE ABOVE OR PROCEDURAL PACKAGING SPECIFICATION APPLIES.'),
  ('PKG_CAT:01', 'NUMERIC-POSITIONS 1 AND 2', 'BARE METAL ITEMS. IRON, STEEL (BARE OR BLACK OXIDE COATED); ...');

-- Packaging rows. Columns: rn, pica_sica, pkg_cat, unpkg weight/width/length/height, ui, tos, icq, mop, clng_drying, pres_mat, wrap_mat, cush_dun, thk,
-- unit_cont, pkg_data_source, spc_mkg, inter_cont, ucl, lvl_a, lvl_b, lvl_c, unit_pack_weight, up_sz_maxb/maxl/maxh, unit_pack_cube, opi,
-- supplemental_instructions, pkg_design_acty, spi_no, spi_rev, spi_date.
INSERT INTO pub.nsn_packaging (nsn, pica_sica, pkg_cat, unpkg_item_weight, unpkg_item_width, unpkg_item_length, unpkg_item_height, ui, tos, icq, mop, clng_drying,
  pres_mat, wrap_mat, cush_dun, thk, unit_cont, pkg_data_source, spc_mkg, inter_cont, ucl, lvl_a, lvl_b, lvl_c, unit_pack_weight, up_sz_maxb, up_sz_maxl, up_sz_maxh,
  unit_pack_cube, opi, supplemental_instructions, pkg_design_acty, spi_no, spi_rev, spi_date)
SELECT s.nsn, v.pica, v.cat, v.uw::numeric, v.uwid::numeric, v.ulen::numeric, v.uh::numeric, v.ui, v.tos, v.icq, v.mop, v.clng, v.pres, v.wrap, v.cush, v.thk, v.cont,
       v.src, v.spc, v.inter, v.ucl, v.la, v.lb, v.lc, v.upw::numeric, v.upb::numeric, v.upl::numeric, v.uph::numeric, v.cube::numeric, v.opi, v.supp, v.design, v.spi, v.rev, v.spid
FROM ship_seed_nsns s
JOIN (VALUES
  -- rn 1: packaging only (NIIN 000182463)
  (1, 'P', NULL, NULL, NULL, NULL, NULL, NULL, 'B', '000', '10', '1', '00', '00', 'NA', 'C', 'D3', 'P', '00', '00', NULL, 'Q', 'Q', NULL,
      1.5000, NULL, NULL, NULL, 0.0070, 'O', 'IP056: MERCURY OR MERCURY', NULL, NULL, NULL, NULL),
  -- rn 3: the P row (richest): values of NIINs 000000121 and 000000050 combined
  (3, 'P', '27B0', 1.0000, 5.000, 7.500, 1.500, 'EA', 'A', 'AAA', '10', '1', '00', 'K3', 'NB', 'A', 'NS', 'P', '01', '00', 'A', 'Q', 'F', 'E',
      1350.0000, 63.30000, 95.00000, 47.60000, 165.6490, 'A', 'IP056: MERCURY OR MERCURY', NULL, 'F004546662', 'D', '89326'),
  -- rn 3: the S row (different values; must not be shown)
  (3, 'S', 'ZZ00', NULL, NULL, NULL, NULL, 'EA', 'A', 'AAA', '31', '1', '00', '00', 'NA', 'C', 'NS', 'P', '39', '00', 'O', 'Q', 'Q', NULL,
      9.0000, NULL, NULL, NULL, 0.5000, 'A', NULL, NULL, NULL, NULL, NULL),
  -- rn 4: very long unbroken text
  (4, 'P', 'ZZ10', NULL, NULL, NULL, NULL, 'EA', 'A', 'AAA', '31', '1', '00', '00', 'NA', 'C', 'NS', 'P', 'ZZ', '00', 'A', 'Q', NULL, NULL,
      2.0000, 10.00000, 12.00000, 8.000000, 0.5560, 'A',
      'SEEDLONGSUPPLEMENTALINSTRUCTIONSWITHNOSPACESATALLTOTESTWRAPPING' || repeat('ABCDEFGHIJ0123456789', 20), NULL,
      'AM' || repeat('0123456789', 6) || 'XYZ', 'D', '89326'),
  -- rn 6: an S row only (NUMERIC-POSITIONS category literal)
  (6, 'S', '01A9', NULL, NULL, NULL, NULL, 'EA', 'A', 'AAA', '31', '1', '00', '00', 'NA', 'C', 'NS', 'P', '39', '00', 'O', 'E', 'F', NULL,
      3.2500, NULL, NULL, NULL, NULL, 'A', NULL, NULL, 'AM12529566', NULL, NULL),
  -- rn 7: codes with no dictionary row at all
  (7, 'P', '9Q11', 0.5, 1.0, 2.0, 3.0, 'EA', 'A', 'AAA', 'GX', '1', '00', '00', 'NA', 'C', 'NS', 'P', 'Q7', '00', 'Y', 'R', 'S', 'T',
      0.7500, 2.00000, 4.00000, 3.000000, 0.0140, 'A', NULL, NULL, NULL, NULL, NULL)
) AS v(rn, pica, cat, uw, uwid, ulen, uh, ui, tos, icq, mop, clng, pres, wrap, cush, thk, cont, src, spc, inter, ucl, la, lb, lc, upw, upb, upl, uph, cube, opi, supp, design, spi, rev, spid)
  ON v.rn = s.rn;

-- Freight rows.
INSERT INTO pub.nsn_freight (nsn, acty_cd, nmfc, nmfc_sub, ufc, hmc, ltl, lcl, rvc, wcc, tcc, shc, adc, acc, nmf_desc)
SELECT s.nsn, v.acty, v.nmfc, v.sub, v.ufc, v.hmc, v.ltl, v.lcl, v.rvc, v.wcc, v.tcc, v.shc, v.adc, v.acc, v.descr
FROM ship_seed_nsns s
JOIN (VALUES
  (2, 'CT', '120800', 'Z', '61410', NULL, 'W', 'M', '1', '593', 'Z', '9', 'A', 'VZ', 'ENGINES, INTERNAL COMBUSTION, NOI'),
  (3, 'TG', '118100', 'Z', '60340', 'AA', 'M', NULL, NULL, '594', '1', 'D', 'Z', 'VD', 'COMPRESSORS, AIR, NOI, OR AIR ENDS'),
  (4, 'AX', '128000', 'X', '64870', NULL, 'Z', NULL, NULL, '594', '3', 'K', 'A', 'VZ', NULL),
  (6, 'AX', '128000', NULL, '64870', NULL, 'K', NULL, NULL, '594', 'R', '9', 'A', 'VZ', 'ELECTRONIC EQUIPMENT PARTS, NOI'),
  (7, 'AX', NULL, NULL, '64870', NULL, 'Q', NULL, NULL, '594', 'X', 'D', 'A', 'VZ', NULL)
) AS v(rn, acty, nmfc, sub, ufc, hmc, ltl, lcl, rvc, wcc, tcc, shc, adc, acc, descr)
  ON v.rn = s.rn;

DROP TABLE ship_seed_nsns;
