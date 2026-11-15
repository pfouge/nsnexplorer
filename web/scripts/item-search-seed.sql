-- Synthetic rows for the item-name search (migration 0018, web/src/lib/item-search-sql.ts) for LOCAL checks only:
-- web/scripts/verify-single-query.mjs --seed. Applied ONLY to the throw-away clone, after flis-seed.sql.
-- Never run against a real database. Deterministic: no random(). All NSNs are 731091xxxxxxx, INCs are 'QS***'.
--
-- Cases:
--   WASHER,LOCK x4 (QS001) with everyday names GRIP WASHER, LOCK WASHER, WASHER LOCK (the last equals the item name)
--   WASHER,SPRING TENSION (QS002) also called LOCK WASHER: a match through an everyday name only
--   WASHER,FLAT (QS003) no everyday name; PACKING,PREFORMED x2 (QS004) also called O-RING and RUBBER RING GASKET
--   LOCK, LOCK,DOOR, PADLOCK, BLOCK,TACKLE, LOCKNUT: exact / prefix / word-start / contains for the word "lock"
--   an NSN with a NULL item name whose INC has an everyday name; an NSN with no identification row; an INC with
--   no NSN; punctuation in names (percent sign, underscore, apostrophe, comma, hyphen); mixed-case names
--   demand signals on the WASHER,LOCK NSNs: open solicitation, open with NULL return date, "open" but already
--   closed, a recent award, a recent award that is only a contract ceiling, an old award

DELETE FROM pub.price_points WHERE nsn LIKE '731091%';
DELETE FROM pub.solicitations WHERE nsn LIKE '731091%';
DELETE FROM pub.nsn_identification WHERE nsn LIKE '731091%';
DELETE FROM pub.inc_colloquial_names WHERE inc LIKE 'QS%';
DELETE FROM pub.nsns WHERE nsn LIKE '731091%';

INSERT INTO pub.nsns (nsn, fsc, item_name) VALUES
  ('7310910000001', '7310', 'WASHER,LOCK'),
  ('7310910000002', '7310', 'WASHER,LOCK'),
  ('7310910000003', '7310', 'WASHER,LOCK'),
  ('7310910000004', '7310', 'Washer,Lock'),
  ('7310910000010', '7310', 'WASHER,SPRING TENSION'),
  ('7310910000020', '7310', 'WASHER,FLAT'),
  ('7310910000030', '7310', 'PACKING,PREFORMED'),
  ('7310910000031', '7310', 'PACKING,PREFORMED'),
  ('7310910000040', '7310', 'LOCK'),
  ('7310910000041', '7310', 'LOCK,DOOR'),
  ('7310910000042', '7310', 'PADLOCK'),
  ('7310910000043', '7310', 'BLOCK,TACKLE'),
  ('7310910000044', '7310', 'LOCKNUT'),
  ('7310910000050', '7310', NULL),
  ('7310910000060', '7310', 'PIN, 50% SPECIAL_ONE O''BRIEN'),
  ('7310910000070', '7310', 'GASKET,SEAL'),
  ('7310910000071', '7310', 'SEAL,GASKET');
-- no identification row for 7310910000070 / 71 (item-name matches only)
INSERT INTO pub.nsn_identification (nsn, inc) VALUES
  ('7310910000001', 'QS001'), ('7310910000002', 'QS001'), ('7310910000003', 'QS001'), ('7310910000004', 'QS001'),
  ('7310910000010', 'QS002'), ('7310910000020', 'QS003'), ('7310910000030', 'QS004'), ('7310910000031', 'QS004'),
  ('7310910000050', 'QS005'), ('7310910000060', 'QS006'), ('7310910000044', NULL);
INSERT INTO pub.inc_colloquial_names (inc, colloquial_name) VALUES
  ('QS001', 'GRIP WASHER'), ('QS001', 'LOCK WASHER'), ('QS001', 'WASHER LOCK'),
  ('QS002', 'LOCK WASHER'), ('QS002', 'Spring Lock Washer'),
  ('QS004', 'O-RING'), ('QS004', 'RUBBER RING GASKET'),
  ('QS005', 'WIDGET LOCK'), ('QS006', 'PERCENT_PIN'),
  ('QS999', 'ORPHAN WASHER');

-- demand signals
INSERT INTO pub.solicitations (sol_number, nsn, quantity, issued_on, return_by, status, source_url, raw, source, nomenclature, fsc) VALUES
  ('SEEDQS-0001', '7310910000003', 5, CURRENT_DATE - 3, CURRENT_DATE + 14, 'open', 'https://example.test/qs1', '{}', 'dibbs_rfq', 'WASHER,LOCK', '7310'),
  ('SEEDQS-0002', '7310910000003', 5, CURRENT_DATE - 2, CURRENT_DATE + 20, 'open', 'https://example.test/qs2', '{}', 'dibbs_rfq', 'WASHER,LOCK', '7310'),
  ('SEEDQS-0003', '7310910000002', 5, CURRENT_DATE - 9, NULL, 'open', 'https://example.test/qs3', '{}', 'dibbs_rfq', 'WASHER,LOCK', '7310'),
  ('SEEDQS-0004', '7310910000001', 5, CURRENT_DATE - 30, CURRENT_DATE - 2, 'open', 'https://example.test/qs4', '{}', 'dibbs_rfq', 'WASHER,LOCK', '7310'),
  ('SEEDQS-0005', '7310910000004', 5, CURRENT_DATE - 30, CURRENT_DATE + 5, 'awarded', 'https://example.test/qs5', '{}', 'dibbs_rfq', 'WASHER,LOCK', '7310');
INSERT INTO pub.price_points (nsn, awarded_on, unit_price, quantity, award_ref, source, source_url, raw) VALUES
  ('7310910000004', CURRENT_DATE - 100, 1.25, 10, 'SPE7M126P0001', 'dibbs_award', 'https://example.test/a1', '{}'),
  ('7310910000001', CURRENT_DATE - 50, 99999, 1, 'SPE7M126D0002', 'dibbs_award', 'https://example.test/a2', '{}'),
  ('7310910000020', CURRENT_DATE - 2000, 2.50, 10, 'SPE7M120P0003', 'dibbs_award', 'https://example.test/a3', '{}'),
  ('7310910000020', CURRENT_DATE - 30, 2.75, 10, 'SPE7M126P0004', 'dibbs_award', 'https://example.test/a4', '{}');
