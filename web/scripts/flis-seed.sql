-- Synthetic FLIS rows (migration 0014) for LOCAL checks only: web/scripts/verify-single-query.mjs --seed.
-- Applied ONLY to the throw-away clone, after verify-single-query-seed.sql (which creates the 7330xxxxxxxxx NSNs).
-- Never run against a real database. Deterministic: no random().
--
-- Cases (rn = position of the NSN among the seeded FSC 7330 NSNs, ordered by nsn):
--   rn 1  identification with every column set, but codes that have no label / no definition anywhere
--         (demil '7', criticality 'Q', esd_emi 'Z', hmic 'zz', unknown schedule B), plus 12 colloquial
--         names (mixed case duplicates) -> the page caps them at 8
--   rn 2  31 cancellations: ties on eff_date, NULL eff_date, NULL FSC, status codes with/without a label,
--         plus a row where THIS nsn is the CANCELLED side (niin differs) which must not be listed
--   rn 3  related items: one with a page (rn 4), one without, one malformed (not 13 digits), ISC without a
--         label, plus a status-only row (related_nsn '') which is not a related item
--   rn 4  60 related rows (the loader returns 50 and the total 60)
--   rn 5  MOE rules: US (DA DF DM DN DS GP VA), unlabeled US-looking code, foreign (V/W/Y/Z/I/O codes, two
--         rule rows for one country), ZX (other), KA (other), NULL moe_cd, NULL AMC/AMSC, SICA = PICA
--   rn 6  identification row with only NIIN_ASGMT (everything else NULL)

DELETE FROM pub.moe_rules WHERE moe_rl LIKE 'SD%';
DELETE FROM pub.nsn_standardization WHERE related_nsn LIKE '99999%' OR isc = '9';
DELETE FROM pub.nsn_cancellations WHERE cancelled_niin LIKE '99%' OR niin LIKE '99%';
DELETE FROM pub.inc_colloquial_names WHERE inc = '99001';
DELETE FROM pub.nsn_identification WHERE inc = '99001' OR nsn IN (SELECT nsn FROM pub.nsns WHERE fsc = '7330');

CREATE TEMP TABLE flis_seed_nsns AS
  SELECT nsn, niin, row_number() OVER (ORDER BY nsn) AS rn FROM pub.nsns WHERE fsc = '7330';

INSERT INTO pub.nsn_identification (nsn, inc, crit_cd, demil, demil_int_cd, niin_assigned, pmic, adp, hmic, esd_emi, hcc, schedule_b, enac, iuid_indicator, last_known_sos, source_file_date)
SELECT nsn, '99001', 'Q', '7', '9', DATE '2001-02-03', 'P', '1', 'zz', 'Z', 'F4', '0000000000', 'K', 'Y', 'S9C', DATE '2026-10-23' FROM flis_seed_nsns WHERE rn = 1;
INSERT INTO pub.nsn_identification (nsn, inc, crit_cd, demil, niin_assigned, pmic, hmic, esd_emi)
SELECT nsn, '99002', 'X', 'D', DATE '2010-05-06', 'A', 'P', 'B' FROM flis_seed_nsns WHERE rn IN (2, 3, 4, 5);
INSERT INTO pub.nsn_identification (nsn, niin_assigned) SELECT nsn, DATE '1999-12-31' FROM flis_seed_nsns WHERE rn = 6;

INSERT INTO pub.inc_colloquial_names (inc, colloquial_name)
SELECT '99001', n FROM unnest(ARRAY['ZETA NAME', 'ALPHA NAME', 'Alpha Name', 'BRAVO,NAME', 'CHARLIE NAME', 'DELTA NAME', 'ECHO NAME', 'FOXTROT NAME', 'GOLF NAME', 'HOTEL NAME', 'INDIA NAME', 'JULIET NAME']) n;

-- rn 2: 31 cancellations of this item, newest first in the page (ties on eff_date, NULL eff_date, NULL FSC)
INSERT INTO pub.nsn_cancellations (niin, cancelled_niin_fsc, cancelled_niin, niin_stat_cd, eff_date, demil, nsn)
SELECT f.niin,
       CASE WHEN k % 7 = 0 THEN NULL ELSE '5340' END,
       '99' || lpad(k::text, 7, '0'),
       (ARRAY['5', '7', '3', '0', 'Q'])[1 + k % 5],
       CASE WHEN k % 9 = 0 THEN NULL ELSE DATE '2020-01-01' + (k / 3) * 30 END,   -- three rows share each date
       'A',
       f.nsn
FROM flis_seed_nsns f, generate_series(1, 31) k WHERE f.rn = 2;
-- ... and a row kept only because the CANCELLED side is this NSN: niin is another item's, must not be listed here
INSERT INTO pub.nsn_cancellations (niin, cancelled_niin_fsc, cancelled_niin, niin_stat_cd, eff_date, demil, nsn)
SELECT '990000001', '7330', f.niin, '5', DATE '2024-01-01', 'A', f.nsn FROM flis_seed_nsns f WHERE f.rn = 2;

-- rn 3: related items
INSERT INTO pub.nsn_standardization (nsn, related_nsn, isc, orig_stdzn_dec, stdzn_date, niin_stat_cd)
SELECT a.nsn, b.nsn, '3', 'CX', DATE '1990-12-07', '0' FROM flis_seed_nsns a, flis_seed_nsns b WHERE a.rn = 3 AND b.rn = 4;
INSERT INTO pub.nsn_standardization (nsn, related_nsn, isc, orig_stdzn_dec, stdzn_date, niin_stat_cd)
SELECT nsn, '9999900000001', '5', '97', NULL, '0' FROM flis_seed_nsns WHERE rn = 3;       -- no page for it
INSERT INTO pub.nsn_standardization (nsn, related_nsn, isc, orig_stdzn_dec, stdzn_date, niin_stat_cd)
SELECT nsn, '99999123', '9', NULL, DATE '2000-01-01', NULL FROM flis_seed_nsns WHERE rn = 3; -- malformed, ISC with no label
INSERT INTO pub.nsn_standardization (nsn, related_nsn, isc, orig_stdzn_dec, stdzn_date, niin_stat_cd)
SELECT nsn, '', '5', '97', DATE '1999-01-01', '0' FROM flis_seed_nsns WHERE rn = 3;       -- status only: not a related item

-- rn 4: 60 related rows (loader returns 50, total 60)
INSERT INTO pub.nsn_standardization (nsn, related_nsn, isc, orig_stdzn_dec, stdzn_date, niin_stat_cd)
SELECT f.nsn, '99999' || lpad(k::text, 8, '0'), '5', '97', DATE '2005-01-01' + k, '0' FROM flis_seed_nsns f, generate_series(1, 60) k WHERE f.rn = 4;

-- rn 5: MOE rules
INSERT INTO pub.moe_rules (nsn, moe_rl, moe_cd, amc, amsc, nimsc, assigned_on, imc, aac, pica, pica_loa, sica, sica_loa)
SELECT f.nsn, v.rl, v.cd, v.amc, v.amsc, NULL, v.d::date, 'Z', v.aac, v.pica, '01', v.sica, '5D'
FROM flis_seed_nsns f,
     (VALUES
       ('SD01', 'DA', '1', 'G', '2006-04-01', NULL, 'GX', 'CD'),
       ('SD02', 'DF', '3', 'D', '2018-04-01', 'D', 'GX', 'TG'),
       ('SD03', 'DM', '1', NULL, NULL, NULL, 'GX', 'GX'),
       ('SD04', 'DN', NULL, NULL, '2022-07-01', NULL, 'GX', NULL),
       ('SD05', 'DS', '5', 'R', '2010-04-01', NULL, 'ZZ', 'ZZ'),
       ('SD06', 'GP', '1', 'B', '2006-04-01', NULL, 'GX', 'XG'),
       ('SD07', 'VA', '4', 'D', '2012-04-01', NULL, 'GX', 'CD'),
       ('SD08', 'QQ', '2', 'G', '2012-04-01', NULL, 'GX', 'CD'),
       ('SD09', 'ZX', NULL, NULL, '2011-10-01', NULL, 'ZX', NULL),
       ('SD10', 'KA', NULL, NULL, '2011-10-01', NULL, 'KA', NULL),
       ('SD11', NULL, NULL, NULL, '2011-10-01', NULL, NULL, NULL),
       ('SD12', 'ZH', NULL, NULL, '1991-04-01', NULL, 'ZH', NULL),
       ('SD13', 'ZH', NULL, NULL, '1992-04-01', NULL, 'ZH', NULL),
       ('SD14', 'YS', NULL, NULL, '2026-10-07', NULL, 'YS', NULL),
       ('SD15', 'WP', NULL, NULL, '2011-07-01', NULL, 'WP', NULL),
       ('SD16', 'VJ', NULL, NULL, '2019-03-01', NULL, 'VJ', NULL),
       ('SD17', 'IB', NULL, NULL, '2019-03-01', NULL, 'IB', NULL),
       ('SD18', 'O2', NULL, NULL, '2019-03-01', NULL, 'O2', NULL),
       ('SD19', 'ZW', NULL, NULL, '1999-04-01', NULL, 'ZW', NULL)
     ) AS v(rl, cd, amc, amsc, d, aac, pica, sica)
WHERE f.rn = 5;

-- A few dictionary rows so some seeded codes DO have labels (the rest stay unlabeled on purpose); never overwrite real ones.
INSERT INTO pub.flis_codes (code, literal, description) VALUES
  ('MOE_CD:ZW', 'TURKEY', 'TURKEY'),
  ('MOE_CD:IB', 'KENYA', 'KENYA'),
  ('MOE_CD:KA', 'LEARJET', 'LEARJET'),
  ('MOE_CD:VA', 'VETERANS ADMINISTRATION', 'VETERANS ADMINISTRATION'),
  ('MOE_CD:DS', 'DEFENSE LOGISTICS AGENCY', 'DEFENSE LOGISTICS AGENCY'),
  ('AAC:D', 'DOD INTEGRATED MATERIEL-MANAGED', 'DOD INTEGRATED MATERIEL-MANAGED'),
  ('NIIN_STAT_CD:3', 'CANCELLED WITH REPLACEMENT', 'CANCELLED WITH REPLACEMENT'),
  ('NIIN_STAT_CD:0', 'ACTIVE', 'ACTIVE'),
  ('NIIN_STAT_CD:5', 'CANCELLED-USE', 'CANCELLED-USE'),
  ('NIIN_STAT_CD:7', 'CANCELLED AS DUPLICATE', 'CANCELLED AS DUPLICATE'),
  ('ISC:3', 'ACCEPTED AS NOT AUTHORIZED FOR PROCUREMENT', 'ACCEPTED AS NOT AUTHORIZED FOR PROCUREMENT'),
  ('ISC:5', 'NOT YET BEEN SUBJECT TO ITEM STANDARDIZATION', 'NOT YET BEEN SUBJECT TO ITEM STANDARDIZATION'),
  ('PMIC:A', 'DOES NOT CONTAIN PRECIOUS METAL', 'ITEM DOES NOT CONTAIN PRECIOUS METAL.'),
  ('PMIC', 'PRECIOUS METALS INDICATOR', 'PRECIOUS METALS INDICATOR CODE (PMIC):  THIS CODE IS TO IDENTIFY ITEMS THAT HAVE PRECIOUS METALS AS PART OF THEIR CONTENT.'),
  ('HMIC:P', 'NO INFORMATION IN HMIRS', 'INDICATES THERE IS NO INFORMATION IN THE HMIRS.'),
  ('HMIC', 'HAZARDOUS MATERIAL INDICATOR', 'HAZARDOUS MATERIALS INDICATOR CODE:  A CODE ESTABLISHED IN THE DLIS TOTAL ITEM RECORD (TIR).'),
  ('NIIN_ASGMT', 'THE DATE THE NATIONAL STOCK NUMBER /NIIN/ WAS CREATED', 'THE DATE THE NATIONAL STOCK NUMBER /NIIN/ WAS CREATED')
ON CONFLICT (code) DO NOTHING;

-- rn 6 has only NIIN_ASGMT. Done.
DROP TABLE flis_seed_nsns;
