-- Synthetic data for LOCAL checks of the /supplier/ leaderboard periods, rank trend, long-term-contract-only
-- suppliers and the supplier page class filter. Needs migrations 0011, 0015 and 0017 and at least a few pub.nsns rows.
-- Never run against a real database: it invents suppliers, awards and part numbers. Dates are relative to CURRENT_DATE;
-- safe to run twice (it removes its own price points and part numbers first; the synthetic NSNs stay). Ends with pub.refresh_supplier_stats().
--
--   B7101, B7102  rise: a big award in the last week, almost nothing 30 days ago
--   B7103, B7104  fall: a big award 370-380 days ago (in the 365 days ending 30 days ago, outside the last 12 months)
--   B7105, B7106  new: every award is under 30 days old, so no dollars in the window ending 30 days ago
--   B7107         steady: one award 100 days ago, nobody can pass it by a later award... (it still moves if others enter)
--   B7108         last 90 days only: an award 85 days old and one 95 days old (the 90-day edge)
--   L7101         two long-term contracts, no orders
--   L7102         one long-term contract, no orders
--   L7103         one long-term contract and ordinary purchases
--   H7001         heavy parts lister: 190 listed parts in three classes, 140 of them in the first class

DELETE FROM pub.price_points WHERE cage IN ('B7101','B7102','B7103','B7104','B7105','B7106','B7107','B7108','L7101','L7102','L7103','H7001');
DELETE FROM pub.part_numbers WHERE cage = 'H7001';

INSERT INTO pub.suppliers (cage, name, city, state) VALUES
  ('B7101', 'Riser One Machining', 'Dayton', 'OH'), ('B7102', 'Riser Two Fasteners', 'Wichita', 'KS'),
  ('B7103', 'Faller One Aerospace', 'Tulsa', 'OK'), ('B7104', 'Faller Two Hydraulics', 'Mesa', 'AZ'),
  ('B7105', 'Newcomer One Supply', 'Albany', 'NY'), ('B7106', 'Newcomer Two Metalworks', 'Spokane', 'WA'),
  ('B7107', 'Steady Seals Inc', 'Omaha', 'NE'), ('B7108', 'Recent Edge Industrial', 'Kent', 'WA'),
  ('L7101', 'Long Term Only One LLC', 'Huntsville', 'AL'), ('L7102', 'Long Term Only Two Corp', 'Rockford', 'IL'),
  ('L7103', 'Contract And Orders Co', 'Savannah', 'GA'), ('H7001', 'Heavy Parts Lister Inc', 'Louisville', 'KY')
ON CONFLICT (cage) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, state = EXCLUDED.state;

-- Purchases: (cage, days ago, total). The NSN rotates over the existing NSNs.
WITH nn AS (SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn, count(*) OVER () AS total FROM pub.nsns WHERE nsn NOT LIKE '____009%'),
     a(cage, ago, total, k) AS (VALUES
  ('B7101', 4, 3000000, 1), ('B7101', 200, 50000, 2),
  ('B7102', 6, 2000000, 1), ('B7102', 100, 100000, 2),
  ('B7103', 380, 2500000, 1), ('B7103', 10, 20000, 2),
  ('B7104', 370, 1800000, 1), ('B7104', 20, 30000, 2),
  ('B7105', 12, 1200000, 1),
  ('B7106', 20, 900000, 1), ('B7106', 3, 10, 2),
  ('B7107', 100, 1000000, 1),
  ('B7108', 85, 40000, 1), ('B7108', 95, 60000, 2),
  ('L7103', 40, 5000, 1), ('L7103', 41, 6000, 2), ('L7103', 42, 7000, 3),
  ('H7001', 15, 30000, 1), ('H7001', 70, 20000, 2), ('H7001', 300, 10000, 3))
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
SELECT nn.nsn, CURRENT_DATE - a.ago, 1, NULL, a.total, a.cage, 1, 'SEEDB-' || a.cage || '-' || a.k, 'dibbs_awd',
       'https://www.dibbs.bsm.dla.mil/rfq/seedb-' || a.cage || '-' || a.k, '{}'::jsonb
FROM a JOIN nn ON nn.rn = 1 + ((ascii(right(a.cage, 1)) * 7 + a.k * 5 + a.ago) % nn.total);

-- Long-term contract base awards (D, G or A as the 9th character of the award number, no delivery order): a huge
-- ceiling that must never count as money.
WITH nn AS (SELECT nsn, row_number() OVER (ORDER BY nsn) AS rn, count(*) OVER () AS total FROM pub.nsns WHERE nsn NOT LIKE '____009%'),
     a(cage, ago, total, k, ref) AS (VALUES
  ('L7101', 8, 9000000000, 1, 'SPE7M126D7101'), ('L7101', 30, 5000000000, 2, 'SPE7M126G7102'),
  ('L7102', 14, 7000000000, 1, 'SPE7M126A7103'),
  ('L7103', 20, 8000000000, 1, 'SPE7M126D7104'))
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, award_ref, source, source_url, raw)
SELECT nn.nsn, CURRENT_DATE - a.ago, 100, 10, a.total, a.cage, 1, a.ref, 'dibbs_award',
       'https://www.dibbs.bsm.dla.mil/rfq/seedbl-' || a.cage || '-' || a.k, '{}'::jsonb
FROM a JOIN nn ON nn.rn = 1 + ((ascii(right(a.cage, 1)) * 11 + a.k * 3) % nn.total);

-- H7001's listed parts: classes from pub.fsc; synthetic NSNs only for the extra classes.
WITH cls AS (SELECT fsc, row_number() OVER (ORDER BY fsc) AS c FROM pub.fsc WHERE fsc ~ '^[0-9]{4}$' AND render_depth = 'deep' ORDER BY fsc LIMIT 3),
     gen AS (
       SELECT cls.fsc, cls.c, i, cls.fsc || '009' || lpad((cls.c * 1000 + i)::text, 6, '0') AS nsn
       FROM cls, LATERAL generate_series(1, CASE cls.c WHEN 1 THEN 70 WHEN 2 THEN 30 ELSE 20 END) i)
INSERT INTO pub.nsns (nsn, fsc, item_name) SELECT nsn, fsc, 'SEEDB ITEM ' || i FROM gen ON CONFLICT DO NOTHING;
INSERT INTO pub.part_numbers (nsn, part_number, cage, source, source_url)
SELECT n.nsn, 'SEEDB-' || right(n.nsn, 6) || '-' || p, 'H7001', 'flis', 'https://www.dla.mil/flis'
FROM pub.nsns n
JOIN LATERAL generate_series(1, CASE WHEN n.fsc = (SELECT min(fsc) FROM pub.fsc WHERE fsc ~ '^[0-9]{4}$' AND render_depth = 'deep') THEN 2 ELSE 1 END) p ON true
WHERE n.item_name LIKE 'SEEDB ITEM %'
ON CONFLICT DO NOTHING;

SELECT pub.refresh_supplier_stats() AS stats_rows;
