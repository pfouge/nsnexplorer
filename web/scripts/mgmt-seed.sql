-- Synthetic PUB LOG management rows (migration 0020) for LOCAL checks only: web/scripts/verify-single-query.mjs --seed.
-- Applied ONLY to the throw-away clone, after flis-seed.sql. Never run against a real database. Deterministic.
-- The prices, codes and dates here are made up; they only exercise the loader and its labels.
--
-- Cases (rn = position among the seeded FSC 7330 NSNs ordered by nsn; flis-seed.sql uses rn 1..6):
--   rn 7   one catalog (FLIS) row with every field, labels on file for UI, AAC, SOS, CIIC
--   rn 8   catalog row plus ARMY / NAVY / AIR_FORCE rows: different prices, units, shelf life codes (Type I, 0, unknown), SOS labels
--   rn 9   zero price, shelf life code 0, no effective date
--   rn 10  missing and unparsable price (unit_price NULL, raw text kept), unknown shelf life code, no unit of issue
--   rn 11  only foreign / other MOE rows (ZC, ZX) which the page leaves out, plus a US MOE row (DA) with a label
--   rn 12  Type II shelf life code, SOS label found only under LST_KWN_SOS, extra jsonb, repairability code
--   rn 13  nothing (no management row)

DELETE FROM pub.nsn_management WHERE nsn IN (SELECT nsn FROM pub.nsns WHERE fsc = '7330');
DELETE FROM pub.flis_codes WHERE code IN ('UI:EA', 'UI:BX', 'CIIC:U', 'SOS:S9C', 'SOS:N32', 'LST_KWN_SOS:S7Z', 'SLC:Q9', 'AAC:J', 'MOE_CD:DA')
  AND description LIKE 'MGMT SEED%';

CREATE TEMP TABLE mgmt_seed_nsns AS
  SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn FROM pub.nsns WHERE fsc = '7330';

-- Dictionary rows (never overwrite real ones). Which spellings production uses is unknown; see the loader header.
INSERT INTO pub.flis_codes (code, literal, description) VALUES
  ('UI:EA', 'EACH', 'MGMT SEED'),
  ('UI:BX', 'BOX', 'MGMT SEED'),
  ('CIIC:U', 'UNCLASSIFIED', 'MGMT SEED'),
  ('SOS:S9C', 'DLA TROOP SUPPORT', 'MGMT SEED'),
  ('SOS:N32', 'NAVY ICP', 'MGMT SEED'),
  ('LST_KWN_SOS:S7Z', 'LAST KNOWN SOURCE', 'MGMT SEED'),
  ('AAC:J', 'LIMITED ACQUISITION', 'MGMT SEED'),
  ('MOE_CD:DA', 'DEPARTMENT OF THE ARMY', 'MGMT SEED')
ON CONFLICT (code) DO NOTHING;

INSERT INTO pub.nsn_management (nsn, source, moe_cd, effective_date, aac, sos, ui, unit_price, unit_price_raw, qup, ciic, slc, repairability, extra, source_file_date)
SELECT m.nsn, v.source, v.moe, v.eff::date, v.aac, v.sos, v.ui, v.price::numeric, v.raw, v.qup, v.ciic, v.slc, v.rc, v.extra::jsonb, DATE '2026-10-23'
FROM mgmt_seed_nsns m
JOIN (VALUES
  (7,  'FLIS',      '',   '2026-07-02', 'D',  'S9C', 'EA', '20.00', '20.00', '1',  'U',  'H',  NULL, NULL),
  (8,  'FLIS',      '',   '2026-07-02', 'D',  'S9C', 'EA', '20.00', '20.00', '1',  'U',  'H',  NULL, NULL),
  (8,  'ARMY',      '',   '2026-01-15', 'D',  'S9C', 'EA', '18.25', '18.25', '1',  'U',  'H',  NULL, NULL),
  (8,  'NAVY',      '',   '2025-11-30', 'J',  'N32', 'BX', '240.5', '240.5', '12', NULL, '0',  NULL, NULL),
  (8,  'AIR_FORCE', '',   NULL,         NULL, NULL,  'EA', '19.99', '19.99', NULL, NULL, 'Q9', NULL, NULL),
  (9,  'FLIS',      '',   NULL,         NULL, 'S9C', 'EA', '0.00',  '0.00',  NULL, NULL, '0',  NULL, NULL),
  (10, 'FLIS',      '',   '2020-02-29', 'D',  NULL,  NULL, NULL,    'CALL',  NULL, NULL, 'Z9', NULL, NULL),
  (11, 'FLIS',      'ZC', '2026-07-02', NULL,  NULL, 'EA', '77.00', '77.00', NULL, NULL, NULL, NULL, NULL),
  (11, 'FLIS',      'ZX', '2026-07-02', NULL,  NULL, 'EA', '88.00', '88.00', NULL, NULL, NULL, NULL, NULL),
  (11, 'ARMY',      'DA', '2026-07-02', 'D',  'S9C', 'EA', '31.10', '31.10', NULL, NULL, 'F',  NULL, NULL),
  (12, 'FLIS',      '',   '2026-03-01', 'D',  'S7Z', 'EA', '4.5',   '4.5',   '2',  'U',  '4',  'Z',  '{"SERVICE_NOTE": "n1"}')
) AS v(rn, source, moe, eff, aac, sos, ui, price, raw, qup, ciic, slc, rc, extra) ON v.rn = m.rn;

DROP TABLE mgmt_seed_nsns;
