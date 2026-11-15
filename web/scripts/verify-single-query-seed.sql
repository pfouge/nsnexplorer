-- Synthetic edge-case rows for web/scripts/verify-single-query.mjs.
--
-- Applied ONLY to a throw-away clone of the local database (the verifier makes
-- the clone and drops it afterwards); never run this against a real database.
-- Deterministic: no random(), so every run builds the same rows.
--
-- What it adds on top of the seeded dev data:
--   * agencies with padded / blank names, FSCs with placeholder / blank / excluded names
--   * NSNs with null item names, null/nested characteristics, null hazmat, several AMSC observations
--   * ~95 suppliers (null / blank / padded names and cities), 20 of them with no awards,
--     one with 260 awards (the page lists 200), many equal award dates (tie ordering)
--   * price points with null quantity / total / agency / cage, zero and long-decimal prices,
--     microsecond timestamps, and 120 awards citing ONE solicitation (the page lists 100)
--   * solicitations: open (future), open (past-due -> 'expired'), open with no dates, expired,
--     awarded, cancelled, unknown; null NSN, null FSC, placeholder / excluded FSC; same-date ties
--   * contract actions whose raw JSON carries the NSN, with padded / empty / missing cage
--   * part numbers with / without cage, cages that are not in pub.suppliers, same part under two cages

BEGIN;

INSERT INTO pub.agencies (agency_id, name, abbreviation) VALUES
  (4, '  Defense Contract Management Agency  ', 'DCMA'),
  (5, '   ', NULL),
  (6, 'Department of the Air Force', 'USAF');

INSERT INTO pub.fsc (fsc, name, render_depth) VALUES
  ('7310', 'FSC 7310', 'shallow'),          -- ingest placeholder name
  ('7320', '   ', 'shallow'),               -- blank name
  ('7330', 'Kitchen Equipment', 'deep'),
  ('7340', 'Cutlery and Flatware', 'shallow'),
  ('J056', 'Maintenance of Tubing', 'excluded')
ON CONFLICT (fsc) DO NOTHING;

-- 40 new NSNs over the new FSCs (plus the already-present J056/9999 excluded ones).
INSERT INTO pub.nsns (nsn, fsc, item_name, characteristics, hazmat)
SELECT (ARRAY['7310','7320','7330','7340'])[1 + i % 4] || lpad(i::text, 9, '0'),
       (ARRAY['7310','7320','7330','7340'])[1 + i % 4],
       CASE WHEN i % 6 = 0 THEN NULL ELSE 'SEED ITEM ' || i END,
       CASE i % 4
         WHEN 0 THEN NULL
         WHEN 1 THEN '[{"mrc": "MATT", "reply": "STEEL", "requirement": "MATERIAL"}]'::jsonb
         WHEN 2 THEN '{"weight": 12.50, "dims": [1.0, 2.25, 3], "note": null, "big": 12345678901234567890}'::jsonb
         ELSE 'null'::jsonb
       END,
       CASE i % 3 WHEN 0 THEN true WHEN 1 THEN false ELSE NULL END
FROM generate_series(1, 40) i;

-- AMSC observations: several per NSN on distinct dates (latest wins), some NSNs with none.
INSERT INTO pub.amsc_observations (nsn, amc, amsc, observed_on, source, source_ref, source_url)
SELECT n.nsn, (ARRAY['1','2','5','0'])[1 + k % 4], (ARRAY['A','Z','G','D'])[1 + k % 4],
       DATE '2025-01-01' + (k * 37),
       'flis', 'seed-' || n.nsn || '-' || k, 'https://example.test/amsc/' || n.nsn || '/' || k
FROM (SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn FROM pub.nsns WHERE fsc IN ('7310', '7320', '7330', '7340')) n,
     generate_series(0, 2) k
WHERE n.rn % 3 <> 0;

-- Suppliers Z0001..Z0095.
INSERT INTO pub.suppliers (cage, name, city, state)
SELECT 'Z' || lpad(i::text, 4, '0'),
       CASE WHEN i % 13 = 0 THEN NULL WHEN i % 17 = 0 THEN '   ' WHEN i % 5 = 0 THEN '  Seed Supply ' || i || '  ' ELSE 'SEED SUPPLY ' || i END,
       CASE WHEN i % 7 = 0 THEN NULL WHEN i % 11 = 0 THEN '' ELSE 'Town ' || i END,
       CASE WHEN i % 7 = 0 THEN NULL ELSE (ARRAY['OH','TX','CA','PA','VA'])[1 + i % 5] END
FROM generate_series(1, 95) i;

-- Solicitations (plain SQL, deterministic). 'SEED-BIG' is cited by 120 awards below.
INSERT INTO pub.solicitations (sol_number, nsn, fsc, nomenclature, quantity, unit_of_issue, issued_on, return_by,
                               status, setaside, buyer_office, source_url, source, raw)
SELECT 'SEED-' || lpad(i::text, 4, '0'),
       CASE WHEN i % 9 = 0 THEN NULL ELSE (SELECT nsn FROM (SELECT nsn, row_number() OVER (ORDER BY nsn) rn FROM pub.nsns) x WHERE x.rn = 1 + (i * 53) % 4120) END,
       CASE i % 8 WHEN 0 THEN NULL WHEN 1 THEN '7310' WHEN 2 THEN 'J056' WHEN 3 THEN '7330' WHEN 4 THEN '7320' WHEN 5 THEN '5340' WHEN 6 THEN '9999' ELSE '7340' END,
       CASE WHEN i % 5 = 0 THEN NULL ELSE 'SEED NOMENCLATURE ' || i END,
       CASE WHEN i % 4 = 0 THEN NULL ELSE (i % 50) + 0.5 END,
       CASE WHEN i % 6 = 0 THEN NULL ELSE 'EA' END,
       CASE WHEN i % 10 = 0 THEN NULL ELSE CURRENT_DATE - 30 - (i % 40) END,
       CASE WHEN i % 12 = 0 THEN NULL
            WHEN i % 3 = 0 THEN CURRENT_DATE + 5 + (i % 20)    -- future
            ELSE CURRENT_DATE - 1 - (i % 3) * 10 END,          -- past (equal dates -> sol_number tiebreak)
       (ARRAY['open','open','open','expired','awarded','cancelled','unknown','open'])[1 + i % 8],
       CASE WHEN i % 3 = 0 THEN 'SB' END,
       CASE WHEN i % 4 = 0 THEN 'DLA LAND' END,
       'https://example.test/rfq/' || i,
       CASE WHEN i % 7 = 0 THEN 'sam_gov' ELSE 'dibbs_rfq' END, '{}'::jsonb
FROM generate_series(1, 160) i;
INSERT INTO pub.solicitations (sol_number, nsn, fsc, status, source_url, raw)
SELECT 'SEED-BIG', nsn, '7330', 'awarded', 'https://example.test/rfq/big', '{}'::jsonb
FROM pub.nsns WHERE fsc = '7330' ORDER BY nsn LIMIT 1;

-- Several solicitations on one NSN with equal return_by (sol_number tiebreak) and null dates (NULLS LAST).
INSERT INTO pub.solicitations (sol_number, nsn, fsc, status, issued_on, return_by, source_url, raw)
SELECT 'SEED-TIE-' || k, n.nsn, n.fsc, 'open',
       CASE WHEN k % 2 = 0 THEN NULL ELSE DATE '2026-01-01' END,
       CASE WHEN k % 3 = 0 THEN NULL ELSE CURRENT_DATE + 30 END,
       'https://example.test/rfq/tie' || k, '{}'::jsonb
FROM (SELECT nsn, fsc FROM pub.nsns WHERE fsc = '7330' ORDER BY nsn LIMIT 1) n, generate_series(1, 6) k;

-- Price points. Supplier Z0001 gets 260 awards, the rest 1..7, Z0076..Z0095 none.
-- NSNs are picked from the whole table by position.
CREATE TEMP TABLE seed_nsns AS SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn FROM pub.nsns;
CREATE TEMP TABLE seed_sols AS SELECT sol_number, row_number() OVER (ORDER BY sol_number) AS rn FROM pub.solicitations WHERE sol_number LIKE 'SEED-%';

INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, sol_number,
                              award_ref, source, source_url, raw, ingested_at)
SELECT n.nsn,
       DATE '2024-01-01' + (k / 3),                                    -- three awards per day: ties
       CASE k % 9 WHEN 0 THEN 0 WHEN 1 THEN 0.123456789 WHEN 2 THEN 1234567.8912 ELSE round((k % 97 + 1) * 1.37, 2) END,
       CASE WHEN k % 5 = 0 THEN NULL ELSE (k % 40) + 1 END,
       CASE WHEN k % 3 = 0 AND k % 11 <> 0 THEN round(((k % 97 + 1) * 1.37) * ((k % 40) + 1), 2) END,
       CASE WHEN k % 29 = 0 THEN NULL ELSE s.cage END,
       CASE WHEN k % 4 = 0 THEN NULL ELSE 1 + k % 6 END,
       CASE WHEN k % 6 = 0 THEN (SELECT sol_number FROM seed_sols WHERE rn = 1 + (k * 7) % 160) END,
       'SEED-A-' || s.cage || '-' || k, 'dibbs_awd', 'https://example.test/award/' || s.cage || '/' || k, '{}'::jsonb,
       TIMESTAMPTZ '2026-09-01 10:00:00.123456+00' + (k || ' seconds')::interval + (CASE WHEN k % 4 = 0 THEN interval '0.000999 seconds' ELSE interval '0' END)
FROM (SELECT 'Z' || lpad(i::text, 4, '0') AS cage, i FROM generate_series(1, 75) i) s,
     LATERAL generate_series(1, CASE WHEN s.i = 1 THEN 260 ELSE 1 + s.i % 7 END) k,
     LATERAL (SELECT nsn FROM seed_nsns WHERE rn = 1 + ((s.i * 131 + k * 17) % 4120)) n;

-- Awards on EXISTING dev NSNs (several per NSN, equal dates, to exercise tie ordering on the NSN page).
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
SELECT n.nsn, DATE '2026-02-01' + (k % 2), 10 + k, k, NULL, 'Z' || lpad((1 + k % 40)::text, 4, '0'), 1 + k % 3,
       'SEED-B-' || n.nsn || '-' || k, 'dibbs_awd', 'https://example.test/awardb/' || n.nsn || '/' || k, '{}'::jsonb
FROM (SELECT nsn, row_number() OVER (ORDER BY nsn) rn FROM pub.nsns WHERE fsc IN ('5340', '5330')) n, generate_series(1, 4) k
WHERE n.rn % 11 = 0;

-- 120 awards citing SEED-BIG, equal dates in threes.
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, cage, agency_id, sol_number, award_ref, source, source_url, raw)
SELECT (SELECT nsn FROM pub.solicitations WHERE sol_number = 'SEED-BIG'), DATE '2025-03-01' + (k / 3), 5 + k, 1 + k % 9,
       CASE WHEN k % 10 = 0 THEN NULL ELSE 'Z' || lpad((1 + k % 60)::text, 4, '0') END,
       NULL, 'SEED-BIG', 'SEED-BIGAW-' || k, 'dibbs_awd', 'https://example.test/award/big/' || k, '{}'::jsonb
FROM generate_series(1, 120) k;

-- Contract actions carrying the NSN (and sometimes a cage) in raw.
INSERT INTO pub.contract_actions (award_uid, piid, psc, naics, description, action_date, obligation, agency_id,
                                  recipient_name, recipient_uei, source_url, raw)
SELECT 'SEED-CA-' || k, CASE WHEN k % 4 = 0 THEN NULL ELSE 'PIID' || k END, CASE WHEN k % 5 = 0 THEN NULL ELSE '5340' END,
       '332722', CASE WHEN k % 6 = 0 THEN NULL ELSE 'seed action ' || k END,
       CASE WHEN k % 7 = 0 THEN NULL ELSE DATE '2025-06-01' + (k % 5) END,
       CASE WHEN k % 3 = 0 THEN NULL ELSE round(k * 1234.567, 2) END,
       CASE WHEN k % 4 = 1 THEN NULL ELSE 1 + k % 6 END,
       'RECIPIENT ' || k, CASE WHEN k % 2 = 0 THEN 'UEI' || k END, 'https://example.test/ca/' || k,
       CASE k % 5
         WHEN 0 THEN jsonb_build_object('nsn', n.nsn, 'cage', 'Z' || lpad((1 + k % 70)::text, 4, '0'))
         WHEN 1 THEN jsonb_build_object('nsn', n.nsn, 'cage', '  Z' || lpad((1 + k % 70)::text, 4, '0') || ' ')
         WHEN 2 THEN jsonb_build_object('nsn', n.nsn, 'cage', '')
         WHEN 3 THEN jsonb_build_object('nsn', n.nsn)
         ELSE jsonb_build_object('nsn', n.nsn, 'cage', NULL)
       END
FROM generate_series(1, 90) k,
     LATERAL (SELECT nsn FROM seed_nsns WHERE rn = 1 + ((k * 61) % 4120)) n;
-- A few NSNs with several actions on the same date.
INSERT INTO pub.contract_actions (award_uid, action_date, source_url, raw)
SELECT 'SEED-CAT-' || k, DATE '2025-07-01', 'https://example.test/cat/' || k, jsonb_build_object('nsn', n.nsn)
FROM (SELECT nsn FROM pub.nsns ORDER BY nsn LIMIT 1) n, generate_series(1, 4) k;

-- Part numbers.
INSERT INTO pub.part_numbers (nsn, part_number, cage, source, source_url)
SELECT n.nsn, 'PN-' || ((k + n.rn) % 9), CASE WHEN k % 4 = 0 THEN NULL WHEN k % 4 = 1 THEN 'Z' || lpad((1 + (n.rn + k) % 90)::text, 4, '0') WHEN k % 4 = 2 THEN 'QQQQ' || k ELSE '1A00' || (1 + k % 5) END,
       'flis', 'https://example.test/pn/' || n.nsn || '/' || k
FROM (SELECT nsn, rn FROM seed_nsns WHERE rn % 5 = 0) n, generate_series(1, 3) k
ON CONFLICT DO NOTHING;
-- Part numbers whose CAGE is not in pub.suppliers (supplier_name comes back null).
INSERT INTO pub.part_numbers (nsn, part_number, cage, source, source_url)
SELECT nsn, 'ORPHAN-' || row_number() OVER (ORDER BY nsn), 'P000' || (row_number() OVER (ORDER BY nsn) % 9 + 1), 'flis', 'https://example.test/pn/orphan/' || nsn
FROM (SELECT nsn FROM pub.nsns ORDER BY nsn DESC LIMIT 12) n;
-- Same part number under two cages.
INSERT INTO pub.part_numbers (nsn, part_number, cage, source, source_url)
SELECT nsn, 'SAMEPN', c, 'flis', 'https://example.test/pn/same/' || c
FROM (SELECT nsn FROM pub.nsns ORDER BY nsn OFFSET 3 LIMIT 1) n, (VALUES ('Z0002'), ('Z0001'), ('1A002')) c(c)
ON CONFLICT DO NOTHING;

-- Contract ceilings (lib/contract-ceiling.ts). One NSN, two suppliers, one solicitation purchase request.
--   ZC001 holds the long-term contract: a base award of type D (ceiling $60,000,000,000, no delivery order) and two
--   delivery orders against it; ZC002 holds type G, A and P/V rows. Also a D base row whose deliveryOrder is blank
--   text and one whose deliveryOrder key is missing, and a non-DIBBS (USAspending) row that looks like a ceiling.
--   Expected: the D/G/A base rows (6) are ceilings; the orders, P, V and USAspending rows are not.
INSERT INTO pub.suppliers (cage, name, city, state) VALUES
  ('ZC001', 'CEILING SEED CONTRACTOR', 'Dayton', 'OH'),
  ('ZC002', 'CEILING SEED SECOND', 'Austin', 'TX');
INSERT INTO pub.solicitations (sol_number, nsn, fsc, nomenclature, quantity, unit_of_issue, issued_on, return_by, status, source_url, source, raw)
SELECT 'SEED-CEIL-1', n.nsn, n.fsc, 'SEED CEILING ITEM', 40, 'EA', CURRENT_DATE - 60, CURRENT_DATE - 45, 'awarded',
       'https://example.test/rfq/ceil1', 'dibbs_rfq', '{"purchaseRequest": "PRCEIL0001"}'::jsonb
FROM (SELECT nsn, fsc FROM pub.nsns WHERE fsc = '5340' ORDER BY nsn OFFSET 5 LIMIT 1) n;
INSERT INTO pub.contract_actions (award_uid, piid, psc, description, action_date, obligation, agency_id, recipient_name, source_url, raw)
SELECT v.uid, v.piid, '5340', 'SEED CEILING ' || v.piid, CURRENT_DATE - v.age, v.obl, NULL, v.recip,
       'https://www.dibbs.bsm.dla.mil/Awards/seedceil/' || v.uid,
       jsonb_build_object('nsn', n.nsn, 'cage', v.cage, 'awardNumber', split_part(v.piid, '/', 1), 'purchaseRequest', 'PRCEIL0001', 'total', v.obl::text)
       || CASE WHEN v.dord IS NOT NULL THEN jsonb_build_object('deliveryOrder', v.dord) ELSE '{}'::jsonb END
FROM (SELECT nsn FROM pub.nsns WHERE fsc = '5340' ORDER BY nsn OFFSET 5 LIMIT 1) n,
     (VALUES
       ('DIBBS-SPE7M126D0001-PRCEIL0001',                       'SPE7M126D0001',                 60000000000::numeric, 50, 'ZC001', 'CEILING SEED CONTRACTOR', NULL::text),   -- D base: ceiling
       ('DIBBS-SPE7M126D0001-SPE7M126F0001-PRCEIL0001',         'SPE7M126D0001/SPE7M126F0001',   1250::numeric,        40, 'ZC001', 'CEILING SEED CONTRACTOR', 'SPE7M126F0001'), -- order: purchase
       ('DIBBS-SPE7M126D0001-SPE7M126F0002-PRCEIL0001',         'SPE7M126D0001/SPE7M126F0002',   2500::numeric,        30, 'ZC001', 'CEILING SEED CONTRACTOR', 'SPE7M126F0002'), -- order: purchase
       ('DIBBS-SPE7M126G0003-PRCEIL0001',                       'SPE7M126G0003',                 100000000::numeric,   55, 'ZC002', 'CEILING SEED SECOND',     NULL),   -- G base: ceiling
       ('DIBBS-SPE7M126A0004-PRCEIL0001',                       'SPE7M126A0004',                 250000::numeric,      35, 'ZC002', 'CEILING SEED SECOND',     ''),     -- A base, blank order: ceiling
       ('DIBBS-SPE7M126P0002-PRCEIL0001',                       'SPE7M126P0002',                 5000::numeric,        25, 'ZC002', 'CEILING SEED SECOND',     NULL),   -- P standalone: purchase
       ('DIBBS-SPE7M126V0005-PRCEIL0001',                       'SPE7M126V0005',                 777::numeric,         20, 'ZC002', 'CEILING SEED SECOND',     NULL),   -- V standalone: purchase
       ('DIBBS-SPE7M126D0008-PRCEIL0001',                       'SPE7M126D0008',                 9000000::numeric,     15, 'ZC001', 'CEILING SEED CONTRACTOR', '   ')    -- D base, whitespace order: ceiling
     ) AS v(uid, piid, obl, age, cage, recip, dord);
-- A USAspending row with a D at the 9th character and no delivery order: not a DIBBS award, never a ceiling.
INSERT INTO pub.contract_actions (award_uid, piid, psc, description, action_date, obligation, agency_id, recipient_name, recipient_uei, source_url, raw)
SELECT 'CONT_AWD_SPE7M126D0006_9700_-NONE-_-NONE-', 'SPE7M126D0006', '5340', 'SEED USASPENDING D-TYPE', CURRENT_DATE - 10, 999999, 1,
       'USA SEED RECIPIENT', 'USASEEDUEI01', 'https://www.usaspending.gov/award/CONT_AWD_SPE7M126D0006', jsonb_build_object('nsn', n.nsn)
FROM (SELECT nsn FROM pub.nsns WHERE fsc = '5340' ORDER BY nsn OFFSET 5 LIMIT 1) n;
-- Price points the award join derived from the same awards (unit price = total / solicitation quantity 40).
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, sol_number, award_ref, source, source_url, raw)
SELECT n.nsn, CURRENT_DATE - v.age, v.total / 40, 40, v.total, v.cage, 'SEED-CEIL-1', v.ref, 'dibbs_award',
       'https://www.dibbs.bsm.dla.mil/Awards/seedceil/pp/' || v.ref, '{}'::jsonb
FROM (SELECT nsn FROM pub.nsns WHERE fsc = '5340' ORDER BY nsn OFFSET 5 LIMIT 1) n,
     (VALUES
       ('SPE7M126D0001',               60000000000::numeric, 50, 'ZC001'),   -- ceiling
       ('SPE7M126D0001-SPE7M126F0001', 1250::numeric,        40, 'ZC001'),   -- order
       ('SPE7M126G0003',               100000000::numeric,   55, 'ZC002'),   -- ceiling
       ('SPE7M126P0002',               5000::numeric,        25, 'ZC002')    -- standalone
     ) AS v(ref, total, age, cage);

-- Same requirement on DIBBS and SAM.gov (web/src/lib/sol-twin.ts). DIBBS spells the number with dashes, SAM.gov without.
INSERT INTO pub.solicitations (sol_number, nsn, fsc, nomenclature, quantity, issued_on, return_by, status, source_url, source, raw)
SELECT v.sol, CASE WHEN v.src = 'dibbs_rfq' THEN n.nsn END, '5340', 'SEED TWIN ' || v.grp, 10, CURRENT_DATE - 5, v.ret, v.st,
       CASE WHEN v.src = 'dibbs_rfq' THEN 'https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=seed' || v.grp || '&category=nsn'
            ELSE 'https://sam.gov/opp/seed' || v.sol || '/view' END,
       v.src, '{}'::jsonb
FROM (SELECT nsn FROM pub.nsns WHERE fsc = '5340' ORDER BY nsn OFFSET 7 LIMIT 1) n,
     (VALUES
       -- grp A: a clean pair, both open
       ('SPE9Z1-26-T-0001', 'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'A'),
       ('SPE9Z126T0001',    'sam_gov',   'open',      CURRENT_DATE + 9,  'A'),
       -- grp B: a pair where the DIBBS row is closed and the SAM.gov notice still open
       ('SPE9Z1-26-T-0002', 'dibbs_rfq', 'expired',   CURRENT_DATE - 3,  'B'),
       ('SPE9Z126T0002',    'sam_gov',   'open',      CURRENT_DATE + 20, 'B'),
       -- grp C: three rows on one key (two SAM.gov spellings): never paired
       ('SPE9Z1-26-T-0003', 'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'C'),
       ('SPE9Z126T0003',    'sam_gov',   'open',      CURRENT_DATE + 9,  'C'),
       ('spe9z126t0003',    'sam_gov',   'open',      CURRENT_DATE + 9,  'C'),
       -- grp D: one digit apart, same dates: not a pair
       ('SPE9Z1-26-T-0004', 'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'D'),
       ('SPE9Z126T0005',    'sam_gov',   'open',      CURRENT_DATE + 9,  'D'),
       -- grp E: same key on two DIBBS spellings: not a pair
       ('SPE9Z1-26-T-0006', 'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'E'),
       ('SPE9Z126T0006',    'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'E'),
       -- grp F: not shaped like a DLA number: not a pair
       ('SEED-TWIN-F',      'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'F'),
       ('SEEDTWINF',        'sam_gov',   'open',      CURRENT_DATE + 9,  'F'),
       -- grp G: a pair whose SAM.gov notice is already expired: counted once
       ('SPE9Z1-26-T-0007', 'dibbs_rfq', 'open',      CURRENT_DATE + 9,  'G'),
       ('SPE9Z126T0007',    'sam_gov',   'expired',   CURRENT_DATE - 1,  'G')
     ) AS v(sol, src, st, ret, grp);

COMMIT;
ANALYZE;
