-- Synthetic supplier-profile data for LOCAL checks only (page builds, screenshots, and
-- web/scripts/verify-single-query.mjs --seed). Needs migration 0011 applied first.
-- Never run against a real database: it invents suppliers, awards, SAM records and web profiles.
-- Deterministic: no random(); dates are relative to CURRENT_DATE so the "last 12 months" windows
-- always have data. Safe to run twice (it removes its own rows first).
--
-- Cases covered (CAGE: what it exercises):
--   1ABC2  full profile: SAM (DBA, mailing address != physical, POCs, 8(a)/WOSB certs, NAICS with
--          small flags), web status ok with AI summary, products/capabilities/certifications,
--          phone + email, USAspending actions by UEI, parts it makes, open solicitations for them
--   3DEF4  SAM only, no supplier_web row; mailing address identical to the physical one
--   5GHI6  web status robots_blocked; SAM present
--   1A001  OPTED OUT (hide_contact + hide_web) although SAM and web rows exist
--   1A002  web status ok_no_ai (site's own meta description only); awards with no dollar value
--   1A003  inactive/expired registration; web status unreachable
--   Q1001  hide_web only (contact details still shown); Q1002  hide_contact only (website summary still shown)
--   9LNG1  no SAM row at all (and a hostile name in pub.suppliers)
--   Q1001..Q1048  extra awardees with a spread of dollars/wins/NSNs and 24 months of history,
--          for the leaderboard (some with SAM rows and small-business flags)

DELETE FROM pub.price_points WHERE award_ref LIKE 'SEEDQ-%';
DELETE FROM pub.contract_actions WHERE award_uid LIKE '%SEEDSUP-%';
DELETE FROM pub.supplier_optouts WHERE cage IN ('1A001', 'Q1001', 'Q1002');
DELETE FROM pub.supplier_web WHERE cage IN (SELECT cage FROM pub.suppliers WHERE cage LIKE 'Q1%' OR cage IN ('1ABC2','3DEF4','5GHI6','1A001','1A002','1A003','9LNG1'));
DELETE FROM pub.supplier_sam WHERE cage IN (SELECT cage FROM pub.suppliers WHERE cage LIKE 'Q1%' OR cage IN ('1ABC2','3DEF4','5GHI6','1A001','1A002','1A003','9LNG1'));

-- ---------------------------------------------------------------- extra suppliers + awards
INSERT INTO pub.suppliers (cage, name, city, state)
SELECT 'Q' || (1000 + i)::text,
       (ARRAY['Allied','Summit','Pioneer','Liberty','Redline','Cobalt','Meridian','Granite','Falcon','Atlas','Beacon','Delta'])[1 + i % 12] || ' ' ||
       (ARRAY['Fastener','Precision','Hydraulics','Machining','Aerospace Components','Industrial Supply','Seals & Gaskets','Metalworks'])[1 + (i / 3) % 8] || ' ' ||
       (ARRAY['Inc','LLC','Corp','Co'])[1 + i % 4],
       (ARRAY['Dayton','Wichita','Tulsa','Mesa','Fort Worth','Huntsville','Rockford','Spokane','Albany','Louisville','Manchester','Savannah','Omaha','Kent'])[1 + i % 14],
       (ARRAY['OH','KS','OK','AZ','TX','AL','IL','WA','NY','KY','NH','GA','NE','WA'])[1 + i % 14]
FROM generate_series(1, 48) i
ON CONFLICT (cage) DO NOTHING;

-- Awards: supplier i gets (i % 9 + 1) * 3 awards spread over ~26 months; the first 12 suppliers
-- also have a heavy prior year so "rising" and "falling" both appear.
WITH nn AS (SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn, count(*) OVER () AS total FROM pub.nsns),
     gen AS (
       SELECT i, k FROM generate_series(1, 48) i, LATERAL generate_series(1, (i % 9 + 1) * 3 + CASE WHEN i <= 12 THEN 6 ELSE 0 END) k
     )
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
SELECT nn.nsn,
       CASE WHEN i <= 12 AND k % 2 = 0 THEN CURRENT_DATE - (370 + (i * 29 + k * 41) % 330)
            ELSE CURRENT_DATE - ((i * 37 + k * 53) % 700) END,
       round((5 + ((i * 131 + k * 17) % 900))::numeric / 3, 2),
       (1 + (i * 7 + k * 3) % 60)::numeric,
       CASE WHEN k % 5 = 0 THEN NULL ELSE round((5 + ((i * 131 + k * 17) % 900))::numeric / 3, 2) * (1 + (i * 7 + k * 3) % 60) * (1 + (i % 4) * 6) END,
       'Q' || (1000 + i)::text,
       1 + (i + k) % 3,
       'SEEDQ-' || i || '-' || k,
       'dibbs_awd',
       'https://www.dibbs.bsm.dla.mil/rfq/seedq-' || i || '-' || k,
       '{}'::jsonb
FROM gen JOIN nn ON nn.rn = 1 + ((i * 97 + k * 61) % nn.total)
ON CONFLICT DO NOTHING;

-- Prior-year history for two of the dev suppliers so their 12m vs prior comparison has numbers.
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
SELECT n.nsn, CURRENT_DATE - (400 + g * 17), 40 + g, 10 + g, NULL, c.cage, 1 + g % 3, 'SEEDQ-HIST-' || c.cage || '-' || g, 'dibbs_awd',
       'https://www.dibbs.bsm.dla.mil/rfq/seedq-hist-' || c.cage || '-' || g, '{}'::jsonb
FROM (VALUES ('1ABC2'), ('3DEF4')) c(cage)
CROSS JOIN generate_series(1, 9) g
JOIN LATERAL (SELECT nsn FROM pub.nsns ORDER BY nsn OFFSET (g * 11) LIMIT 1) n ON true
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- SAM records
-- 1ABC2: the full profile.
INSERT INTO pub.supplier_sam (cage, uei, legal_name, dba_name, entity_url,
  phys_line1, phys_city, phys_state, phys_zip, phys_zip4, phys_country,
  mail_line1, mail_line2, mail_city, mail_state, mail_zip, mail_country,
  registration_status, registration_date, expiration_date, last_update_date, activation_date, entity_start_date,
  entity_structure, state_of_incorporation, business_types, sba_certifications, primary_naics, naics, psc, pocs, source_file)
VALUES ('1ABC2', 'J7K3M9P2Q4R5', 'ACME FASTENERS INCORPORATED', 'Acme Fasteners & Fittings', 'https://www.acmefasteners.example/',
  '1200 Lakeside Industrial Pkwy', 'Cleveland', 'OH', '44114', '2210', 'USA',
  'PO Box 4417', 'Attn: Contracts', 'Cleveland', 'OH', '44101', 'USA',
  'Active', CURRENT_DATE - 410, CURRENT_DATE + 220, CURRENT_DATE - 40, CURRENT_DATE - 405, DATE '1998-03-02',
  'Corporate Entity (Not Tax Exempt)', 'OH',
  ARRAY['Small Business','Woman Owned Small Business','Economically Disadvantaged Women-Owned Small Business','Subchapter S Corporation'],
  '[{"label":"8(a) Program Participant","entry":"2021-01-01","exit":"2030-01-01"},{"label":"Women-Owned Small Business (WOSB)","entry":"2022-06-15","exit":null}]'::jsonb,
  '332722',
  '[{"code":"332722","small":true},{"code":"332721","small":true},{"code":"423840","small":true},{"code":"336413","small":false}]'::jsonb,
  ARRAY['5305','5306','5310','5330','5340'],
  '[{"role":"Government Business POC","name":"Dana Whitfield","title":"President"},{"role":"Government Business POC, Alternate","name":"Marcus Ellery","title":"Contracts Manager"},{"role":"Electronic Business POC","name":"Priya Raman","title":"Operations Director"}]'::jsonb,
  'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP');

-- 3DEF4: SAM only; mailing address same as physical (so the page shows one address).
INSERT INTO pub.supplier_sam (cage, uei, legal_name, entity_url, phys_line1, phys_city, phys_state, phys_zip, phys_country,
  mail_line1, mail_city, mail_state, mail_zip, mail_country,
  registration_status, registration_date, expiration_date, last_update_date, entity_start_date, entity_structure, state_of_incorporation,
  business_types, sba_certifications, primary_naics, naics, psc, pocs, source_file)
VALUES ('3DEF4', 'M2N8P4R6T1V3', 'BOLT & NUT COMPANY', 'https://boltandnut.example', '88 Refinery Road', 'Tulsa', 'OK', '74103', 'USA',
  '88 Refinery Road', 'Tulsa', 'OK', '74103', 'USA',
  'Active', CURRENT_DATE - 900, CURRENT_DATE + 61, CURRENT_DATE - 12, DATE '2004-09-14', 'Corporate Entity (Not Tax Exempt)', 'OK',
  ARRAY['Other than Small Business'], '[]'::jsonb, '332722', '[{"code":"332722","small":false}]'::jsonb, ARRAY['5310','5320'],
  '[{"role":"Government Business POC","name":"Walt Overmeyer","title":"VP Sales"}]'::jsonb, 'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP');

-- 5GHI6: SAM present, site blocks robots.
INSERT INTO pub.supplier_sam (cage, uei, legal_name, entity_url, phys_line1, phys_city, phys_state, phys_zip, phys_country,
  registration_status, registration_date, expiration_date, last_update_date, entity_structure,
  business_types, sba_certifications, primary_naics, naics, psc, pocs, source_file)
VALUES ('5GHI6', 'B5C7D9F2G4H6', 'SEALS UNLIMITED LLC', 'https://sealsunlimited.example', '2400 Mill St', 'Reno', 'NV', '89502', 'USA',
  'Active', CURRENT_DATE - 300, CURRENT_DATE + 65, CURRENT_DATE - 20, 'Limited Liability Company',
  ARRAY['Small Business','Service Disabled Veteran Owned Small Business'], '[{"label":"Service-Disabled Veteran-Owned Small Business","entry":"2020-02-01","exit":null}]'::jsonb,
  '339991', '[{"code":"339991","small":true},{"code":"326291","small":true}]'::jsonb, ARRAY['5330'],
  '[{"role":"Government Business POC","name":"Elena Voss","title":"Owner"}]'::jsonb, 'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP');

-- 1A001: opted out (SAM and web rows exist but must never reach the page).
INSERT INTO pub.supplier_sam (cage, uei, legal_name, entity_url, phys_line1, phys_city, phys_state, phys_zip, phys_country,
  registration_status, registration_date, expiration_date, last_update_date, entity_structure, business_types, primary_naics, naics, pocs, source_file)
VALUES ('1A001', 'H3J5K7L9N2P4', 'ACME FASTENERS INC (OPTED OUT)', 'https://acme-optout.example', '5 Secret Lane', 'Dayton', 'OH', '45402', 'USA',
  'Active', CURRENT_DATE - 100, CURRENT_DATE + 265, CURRENT_DATE - 5, 'Corporate Entity (Not Tax Exempt)', ARRAY['Small Business'], '332722',
  '[{"code":"332722","small":true}]'::jsonb, '[{"role":"Government Business POC","name":"Hidden Person","title":"Owner"}]'::jsonb, 'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP');
INSERT INTO pub.supplier_optouts (cage, hide_contact, hide_web, note) VALUES ('1A001', true, true, 'seed: requested removal');

-- 1A002: web profile without AI (the site's own description only); 1A003: lapsed registration.
INSERT INTO pub.supplier_sam (cage, uei, legal_name, entity_url, phys_line1, phys_city, phys_state, phys_zip, phys_country,
  registration_status, registration_date, expiration_date, last_update_date, entity_structure, business_types, primary_naics, naics, pocs, source_file)
VALUES
 ('1A002', 'R8S2T4V6W9X1', 'BOLT & NUT CO', 'https://bolt-nut.example/', '9 Ship Channel Dr', 'Houston', 'TX', '77015', 'USA',
  'Active', CURRENT_DATE - 700, CURRENT_DATE + 30, CURRENT_DATE - 60, 'Corporate Entity (Not Tax Exempt)', ARRAY['Small Business'], '423840',
  '[{"code":"423840","small":true}]'::jsonb, '[]'::jsonb, 'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP'),
 ('1A003', 'Y2Z4A6B8C1D3', 'SEALS UNLIMITED OF FRESNO', 'https://fresno-seals.example', '77 Packers Way', 'Fresno', 'CA', '93706', 'USA',
  'Expired', DATE '2019-04-02', CURRENT_DATE - 75, DATE '2024-04-10', 'Corporate Entity (Not Tax Exempt)', ARRAY[]::text[], '339991',
  '[{"code":"339991","small":false}]'::jsonb, '[]'::jsonb, 'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP');

-- Q suppliers: SAM rows for roughly two thirds (small-business mix, several states).
INSERT INTO pub.supplier_sam (cage, uei, legal_name, phys_city, phys_state, phys_country, registration_status, registration_date, expiration_date,
  business_types, primary_naics, naics, source_file)
SELECT s.cage, 'Q' || lpad((row_number() OVER (ORDER BY s.cage))::text, 11, '0'), upper(s.name), s.city, s.state, 'USA', 'Active',
       CURRENT_DATE - 300, CURRENT_DATE + 60,
       CASE WHEN row_number() OVER (ORDER BY s.cage) % 3 = 0 THEN ARRAY['Small Business'] ELSE ARRAY['Other than Small Business'] END,
       '332722',
       CASE WHEN row_number() OVER (ORDER BY s.cage) % 4 = 0 THEN '[{"code":"332722","small":true}]'::jsonb ELSE '[{"code":"332722","small":false}]'::jsonb END,
       'SAM_PUBLIC_MONTHLY_V2_SEED.ZIP'
FROM pub.suppliers s WHERE s.cage LIKE 'Q1%' AND (substr(s.cage, 3)::int % 3) <> 0;

UPDATE pub.suppliers su SET uei = sam.uei FROM pub.supplier_sam sam WHERE sam.cage = su.cage AND su.uei IS DISTINCT FROM sam.uei;

-- ---------------------------------------------------------------- web profiles
INSERT INTO pub.supplier_web (cage, url, final_url, status, fetched_at, pages, summary, products, capabilities, certifications, founded,
  phone, email, contact_url, meta_description, model, error) VALUES
 ('1ABC2', 'https://www.acmefasteners.example/', 'https://www.acmefasteners.example/', 'ok', now() - interval '20 days',
  '[{"url":"https://www.acmefasteners.example/","title":"Acme Fasteners - Home"},{"url":"https://www.acmefasteners.example/about","title":"About Acme"},{"url":"https://www.acmefasteners.example/quality","title":"Quality and certifications"},{"url":"https://www.acmefasteners.example/contact","title":"Contact"}]'::jsonb,
  'An Ohio manufacturer and distributor of threaded fasteners, retaining clips and fittings for aerospace, ground-vehicle and marine customers. The company describes in-house cold forming, plating and lot traceability, and says it supplies military specification hardware to defense primes and to the Defense Logistics Agency.',
  ARRAY['Hex bolts and screws','Retaining clips','Self-locking nuts','Hydraulic fittings','Custom cold-formed parts'],
  ARRAY['Cold forming','Zinc and cadmium plating','Lot traceability','Kitting for depots'],
  ARRAY['ISO 9001:2015','AS9100D','ITAR registered'], 1998,
  '(216) 555-0142', 'quotes@acmefasteners.example', 'https://www.acmefasteners.example/contact',
  'Acme Fasteners makes and stocks military-spec hardware.', 'claude-haiku-4-5', NULL),
 ('5GHI6', 'https://sealsunlimited.example', NULL, 'robots_blocked', now() - interval '9 days', '[]'::jsonb, NULL,
  '{}', '{}', '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('1A001', 'https://acme-optout.example', 'https://acme-optout.example/', 'ok', now() - interval '5 days',
  '[{"url":"https://acme-optout.example/","title":"Home"}]'::jsonb, 'This summary must never be shown: the supplier opted out.',
  ARRAY['Hidden product'], ARRAY['Hidden capability'], ARRAY['ISO 9001'], 2001, '(937) 555-0100', 'info@acme-optout.example', 'https://acme-optout.example/contact',
  'Hidden meta description.', 'claude-haiku-4-5', NULL),
 ('1A002', 'https://bolt-nut.example/', 'https://www.bolt-nut.example/', 'ok_no_ai', now() - interval '33 days',
  '[{"url":"https://www.bolt-nut.example/","title":"Bolt & Nut Co"},{"url":"https://www.bolt-nut.example/contact-us","title":"Contact us"}]'::jsonb, NULL,
  '{}', '{}', '{}', NULL, '(713) 555-0188', 'sales@bolt-nut.example', 'https://www.bolt-nut.example/contact-us',
  'Bolt & Nut Co. is a Houston industrial fastener distributor serving the Gulf Coast since 1987.', NULL, NULL),
 ('1A003', 'https://fresno-seals.example', NULL, 'unreachable', now() - interval '60 days', '[]'::jsonb, NULL,
  '{}', '{}', '{}', NULL, NULL, NULL, NULL, NULL, NULL, 'timeout');

-- Partial opt-outs: Q1001 hides only the website profile, Q1002 hides only contact details.
UPDATE pub.supplier_sam SET phys_line1 = '10 Partial Way', phys_city = 'Dayton', phys_state = 'OH', phys_zip = '45402',
  pocs = '[{"role":"Government Business POC","name":"Pat Partial","title":"Owner"}]'::jsonb WHERE cage IN ('Q1001', 'Q1002');
INSERT INTO pub.supplier_web (cage, url, final_url, status, fetched_at, pages, summary, products, capabilities, certifications, founded, phone, email, contact_url, meta_description, model)
SELECT cage, 'https://' || lower(cage) || '.example/', 'https://' || lower(cage) || '.example/', 'ok', now() - interval '12 days',
  jsonb_build_array(jsonb_build_object('url', 'https://' || lower(cage) || '.example/', 'title', 'Home')),
  'Partial opt-out test profile for ' || cage || '.', ARRAY['Widgets'], ARRAY['Machining'], ARRAY['ISO 9001'], 2005,
  '(555) 555-' || right(cage, 4), 'info@' || lower(cage) || '.example', 'https://' || lower(cage) || '.example/contact', 'Meta for ' || cage, 'claude-haiku-4-5'
FROM pub.suppliers WHERE cage IN ('Q1001', 'Q1002');
INSERT INTO pub.supplier_optouts (cage, hide_contact, hide_web, note) VALUES ('Q1001', false, true, 'seed: hide web only'), ('Q1002', true, false, 'seed: hide contact only');

-- ---------------------------------------------------------------- USAspending actions by UEI
INSERT INTO pub.contract_actions (award_uid, piid, psc, naics, description, action_date, obligation, agency_id, recipient_name, recipient_uei, source_url, raw)
SELECT 'SEEDSUP-' || g, 'SPE7M1-2' || (g % 6) || '-P-' || lpad(g::text, 4, '0'),
       (ARRAY['5310','5305','5340','5330','5306'])[1 + g % 5], '332722',
       (ARRAY['BOLTS, MACHINE','SCREWS, CAP','CLIPS, RETAINING','O-RINGS, PACKING','NUT, SELF-LOCKING'])[1 + g % 5] || ' - DELIVERY ORDER ' || g,
       CURRENT_DATE - (g * 23), (900 + g * 1337)::numeric, 1 + g % 3, 'ACME FASTENERS INCORPORATED', 'J7K3M9P2Q4R5',
       'https://www.usaspending.gov/award/CONT_AWD_SEEDSUP_' || g, '{}'::jsonb
FROM generate_series(1, 31) g;
-- A DIBBS-derived row with the same UEI: the page lists USAspending actions only.
INSERT INTO pub.contract_actions (award_uid, piid, psc, description, action_date, obligation, agency_id, recipient_name, recipient_uei, source_url, raw)
VALUES ('DIBBS-SEEDSUP-1', 'SPE7M1-26-P-9999', '5310', 'DIBBS AWARD ROW (must not be listed)', CURRENT_DATE - 3, 123456, 1, 'ACME FASTENERS INCORPORATED', 'J7K3M9P2Q4R5',
        'https://www.dibbs.bsm.dla.mil/rfq/seedsup-dibbs', '{}'::jsonb);

-- ---------------------------------------------------------------- derived
SELECT pub.refresh_supplier_stats() AS stats_rows;
