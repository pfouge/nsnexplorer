-- 0026: Public parent companies for suppliers (2026-11-24).
--
-- pub.public_companies: one row per publicly traded parent, with facts read from the
--   spotthemoney.com database (SEC revenue, recent 8-K filings, federal lobbying reported for
--   the current year). Refreshed by ingest/public-parents/refresh.mjs when STM_DATABASE_URL is set.
-- pub.parent_rules: reviewed name rules (current legal name in SAM, else catalog name) that tie a
--   CAGE to its parent. Names of divisions sold off are excluded by `exclude`, and a CAGE only
--   counts while it is active in SAM or has won an award since 2021, so old names of sold units
--   do not inherit today's owner.
-- pub.supplier_parent: the resulting CAGE -> parent map, rebuilt from the rules by
--   pub.rebuild_supplier_parent() (called here and by the refresh script).
--
-- Grants: none (read with the owner connection, like 0011). db/migrate.mjs wraps this in a transaction.

CREATE TABLE IF NOT EXISTS pub.public_companies (
  cik            text PRIMARY KEY,
  ticker         text NOT NULL UNIQUE,
  name           text NOT NULL,
  revenue        numeric,
  revenue_period_end date,
  lobbying_year  numeric,
  lobbying_year_label text,
  events         jsonb NOT NULL DEFAULT '[]',
  stm_url        text,
  lobby_pattern  text,           -- regex on the lobbying client name, used by the refresh
  as_of          date NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS pub.parent_rules (
  ticker   text NOT NULL REFERENCES pub.public_companies(ticker) ON UPDATE CASCADE,
  pattern  text NOT NULL,
  exclude  text,
  PRIMARY KEY (ticker, pattern)
);

CREATE TABLE IF NOT EXISTS pub.supplier_parent (
  cage char(5) PRIMARY KEY REFERENCES pub.suppliers(cage) ON DELETE CASCADE,
  cik  text NOT NULL REFERENCES pub.public_companies(cik)
);
CREATE INDEX IF NOT EXISTS supplier_parent_cik ON pub.supplier_parent (cik);

REVOKE ALL ON pub.public_companies, pub.parent_rules, pub.supplier_parent FROM anon, authenticated;

INSERT INTO pub.public_companies (cik, ticker, name, revenue, revenue_period_end, lobbying_year, events, stm_url) VALUES
  ('0000001750', 'AIR', 'AAR Corp.', NULL, NULL, 1810000, '[]'::jsonb, NULL),
  ('0000109563', 'AIT', 'Applied Industrial Technologies', 4966686000, '2026-06-30'::date, NULL, '[{"filed": "2026-10-27", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/109563/000010956326000051/ait-20261027.htm"}, {"filed": "2026-10-22", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/109563/000010956326000040/ait-20261020.htm"}, {"filed": "2026-08-14", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/109563/000010956326000035/ait-20260811.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ait/'),
  ('0001411207', 'ALSN', 'Allison Transmission', NULL, NULL, 670000, '[]'::jsonb, NULL),
  ('0001037868', 'AME', 'AMETEK', 7401116000, '2025-12-31'::date, NULL, '[{"filed": "2026-11-20", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/1037868/000110465926130589/tm2629569d11_8k.htm"}, {"filed": "2026-11-18", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/1037868/000110465926129292/tm2629569d10_8k.htm"}, {"filed": "2026-11-06", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1037868/000103786826000199/ame-20261106.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ame/'),
  ('0000012927', 'BA', 'Boeing', 89463000000, '2025-12-31'::date, 9530000, '[{"filed": "2026-10-27", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/12927/000162828026067411/ba-20261027.htm"}, {"filed": "2026-08-28", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/12927/000162828026059427/ba-20260824.htm"}, {"filed": "2026-08-21", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/12927/000162828026058481/ba-20260819.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ba/'),
  ('0000026172', 'CMI', 'Cummins', 33670000000, '2025-12-31'::date, 2121677, '[{"filed": "2026-11-05", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/26172/000002617226000035/cmi-20261105.htm"}, {"filed": "2026-08-04", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/26172/000002617226000026/cmi-20260804.htm"}, {"filed": "2026-05-14", "item": "5.07", "url": "https://www.sec.gov/Archives/edgar/data/26172/000002617226000018/cmi-20260512.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/cmi/'),
  ('0001944013', 'CR', 'Crane Company', 2305000000, '2025-12-31'::date, NULL, '[{"filed": "2026-10-27", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1944013/000162828026067607/cr-20261027.htm"}, {"filed": "2026-09-29", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1944013/000162828026063845/cr-20260927.htm"}, {"filed": "2026-09-14", "item": "7.01", "url": "https://www.sec.gov/Archives/edgar/data/1944013/000162828026061780/cr-20260914.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/cr/'),
  ('0000026324', 'CW', 'Curtiss-Wright', NULL, NULL, 280000, '[]'::jsonb, NULL),
  ('0000030305', 'DCO', 'Ducommun', 824839000, '2025-12-31'::date, NULL, '[{"filed": "2026-11-05", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/30305/000162828026070480/dco-20261105.htm"}, {"filed": "2026-08-06", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/30305/000162828026053775/dco-20260806.htm"}, {"filed": "2026-05-12", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/30305/000162828026033833/dco-20260512.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/dco/'),
  ('0001833756', 'DRS', 'Leonardo DRS', 3648000000, '2025-12-31'::date, 1595000, '[{"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1833756/000183375626000042/drs-20261029.htm"}, {"filed": "2026-07-30", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1833756/000183375626000037/drs-20260730.htm"}, {"filed": "2026-07-28", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/1833756/000183375626000034/drs-20260728.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/drs/'),
  ('0001551182', 'ETN', 'Eaton', 27448000000, '2025-12-31'::date, 1380000, '[{"filed": "2026-11-03", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1551182/000155118226000037/etn-20261103.htm"}, {"filed": "2026-10-16", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/1551182/000155118226000034/etn-20261016.htm"}, {"filed": "2026-10-05", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1551182/000114036126038523/ef20083229_8k.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/etn/'),
  ('0000815556', 'FAST', 'Fastenal', 8200500000, '2025-12-31'::date, NULL, '[{"filed": "2026-10-14", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/815556/000081555626000046/fast-20261014.htm"}, {"filed": "2026-07-14", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/815556/000081555626000037/fast-20260714.htm"}, {"filed": "2026-06-23", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/815556/000081555626000035/fast-20260618.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/fast/'),
  ('0000040533', 'GD', 'General Dynamics', 52550000000, '2025-12-31'::date, 13257500, '[{"filed": "2026-10-30", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/40533/000004053326000036/gd-20261030.htm"}, {"filed": "2026-10-08", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/40533/000119312526417188/d122892d8k.htm"}, {"filed": "2026-08-07", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/40533/000119312526340490/d129075d8k.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/gd/'),
  ('0000040545', 'GE', 'GE Aerospace', 45855000000, '2025-12-31'::date, 3943000, '[{"filed": "2026-10-20", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/40545/000004054526000063/ge-20261020.htm"}, {"filed": "2026-09-22", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/40545/000004054526000059/ge-20260921.htm"}, {"filed": "2026-09-08", "item": "7.01", "url": "https://www.sec.gov/Archives/edgar/data/40545/000095014226002501/eh260827362_8k.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ge/'),
  ('0001467858', 'GM', 'General Motors', 185019000000, '2025-12-31'::date, 20610000, '[{"filed": "2026-10-29", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1467858/000119312526437768/d128847d8k.htm"}, {"filed": "2026-10-27", "item": "3.01", "url": "https://www.sec.gov/Archives/edgar/data/1467858/000119312526432602/d53522d8k.htm"}, {"filed": "2026-10-20", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1467858/000146785826000056/gm-20261020.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/gm/'),
  ('0000046619', 'HEI', 'HEICO', 4485044000, '2025-10-31'::date, 140000, '[{"filed": "2026-08-25", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/46619/000004661926000018/hei-20260825.htm"}, {"filed": "2026-07-16", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/46619/000121390026078776/ea0298133-8k_heico.htm"}, {"filed": "2026-06-17", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/46619/000121390026069674/ea0294696-8k_heico.htm"}]'::jsonb, NULL),
  ('0001501585', 'HII', 'HII (Huntington Ingalls)', 12484000000, '2025-12-31'::date, 16203777, '[{"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1501585/000150158526000054/hii-20261029.htm"}, {"filed": "2026-10-20", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1501585/000150158526000050/hii-20261019.htm"}, {"filed": "2026-07-30", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1501585/000150158526000045/hii-20260730.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/hii/'),
  ('0002089271', 'HONA', 'Honeywell Aerospace', NULL, NULL, 1370000, '[{"filed": "2026-11-13", "item": "5.08", "url": "https://www.sec.gov/Archives/edgar/data/2089271/000208927126000035/hona-20261113.htm"}, {"filed": "2026-10-28", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/2089271/000208927126000031/hona-20261028.htm"}, {"filed": "2026-08-05", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/2089271/000208927126000020/hona-20260723.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/hona/'),
  ('0000004281', 'HWM', 'Howmet Aerospace', 8252000000, '2025-12-31'::date, 650000, '[{"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/4281/000110465926119857/tm2628456d1_8k.htm"}, {"filed": "2026-08-06", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/4281/000110465926091610/tm2622325d1_8k.htm"}, {"filed": "2026-05-28", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/4281/000110465926067497/hwm-20260528.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/hwm/'),
  ('0000717605', 'HXL', 'Hexcel', NULL, NULL, 540000, '[]'::jsonb, NULL),
  ('0001699150', 'IR', 'Ingersoll Rand', 7650900000, '2025-12-31'::date, 240000, '[{"filed": "2026-10-30", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1699150/000114036126041330/ef20084631_8k.htm"}, {"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1699150/000162828026068260/iri-20261029.htm"}, {"filed": "2026-07-30", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1699150/000162828026051068/iri-20260730.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ir/'),
  ('0000216228', 'ITT', 'ITT Inc.', 3938500000, '2025-12-31'::date, NULL, '[{"filed": "2026-11-04", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/216228/000021622826000072/itt-20261104.htm"}, {"filed": "2026-08-06", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/216228/000021622826000061/itt-20260806.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/itt/'),
  ('0000049826', 'ITW', 'Illinois Tool Works', 16044000000, '2025-12-31'::date, 60000, '[{"filed": "2026-10-27", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/49826/000004982626000057/itw-20261027.htm"}, {"filed": "2026-08-13", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/49826/000119312526349149/d23818d8k.htm"}, {"filed": "2026-07-28", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/49826/000004982626000047/itw-20260728.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/itw/'),
  ('0000833444', 'JCI', 'Johnson Controls', 25666000000, '2026-09-30'::date, 600000, '[{"filed": "2026-10-27", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/833444/000083344426000101/jci-20261027.htm"}, {"filed": "2026-09-30", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/833444/000083344426000098/jci-20260925.htm"}, {"filed": "2026-07-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/833444/000083344426000083/jci-20260729.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/jci/'),
  ('0001069258', 'KTOS', 'Kratos Defense & Security Solutions', NULL, NULL, 480000, '[]'::jsonb, NULL),
  ('0001336920', 'LDOS', 'Leidos', 17174000000, '2026-01-02'::date, 5085000, '[{"filed": "2026-11-03", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1336920/000133692026000290/ldos-20261103.htm"}, {"filed": "2026-10-05", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/1336920/000119312526413208/d157380d8k.htm"}, {"filed": "2026-10-01", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1336920/000133692026000265/ldos-20261001.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ldos/'),
  ('0000202058', 'LHX', 'L3Harris Technologies', NULL, NULL, 2150000, '[{"filed": "2026-11-23", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/202058/000020205826000091/hrs-20261123.htm"}, {"filed": "2026-11-05", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/202058/000020205826000089/hrs-20261102.htm"}, {"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/202058/000020205826000084/hrs-20261029.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/lhx/'),
  ('0000936468', 'LMT', 'Lockheed Martin', 75048000000, '2025-12-31'::date, 14017980, '[{"filed": "2026-10-22", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/936468/000162828026066780/lmt-20261022.htm"}, {"filed": "2026-08-28", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/936468/000119312526371750/d177255d8k.htm"}, {"filed": "2026-07-23", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/936468/000162828026049277/lmt-20260723.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/lmt/'),
  ('0001096056', 'LXFR', 'Luxfer', NULL, NULL, NULL, '[]'::jsonb, NULL),
  ('0000067887', 'MOG.A', 'Moog', 4522939000, '2026-10-03'::date, 230000, '[{"filed": "2026-11-20", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/67887/000162828026075170/mog-20261120.htm"}, {"filed": "2026-07-31", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/67887/000162828026051250/mog-20260731.htm"}, {"filed": "2026-07-06", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/67887/000162828026047105/mog-20260701.htm"}]'::jsonb, NULL),
  ('0001049521', 'MRCY', 'Mercury Systems', NULL, NULL, NULL, '[]'::jsonb, NULL),
  ('0001003078', 'MSM', 'MSC Industrial Supply', NULL, NULL, NULL, '[]'::jsonb, NULL),
  ('0001133421', 'NOC', 'Northrop Grumman', 41954000000, '2025-12-31'::date, 7072500, '[{"filed": "2026-10-20", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1133421/000113342126000037/noc-20261020.htm"}, {"filed": "2026-08-21", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1133421/000162828026058480/noc-20260819.htm"}, {"filed": "2026-07-21", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1133421/000113342126000033/noc-20260721.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/noc/'),
  ('0000775158', 'OSK', 'Oshkosh', 10422300000, '2025-12-31'::date, 2260000, '[{"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/775158/000119312526437039/osk-20261029.htm"}, {"filed": "2026-07-28", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/775158/000119312526318909/osk-20260728.htm"}, {"filed": "2026-05-08", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/775158/000119312526213376/osk-20260508.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/osk/'),
  ('0000076334', 'PH', 'Parker-Hannifin', 21499000000, '2026-06-30'::date, 530000, '[{"filed": "2026-11-05", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/76334/000007633426000170/ph-20261105.htm"}, {"filed": "2026-11-03", "item": "5.07", "url": "https://www.sec.gov/Archives/edgar/data/76334/000007633426000166/ph-20261028.htm"}, {"filed": "2026-09-14", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/76334/000119312526390561/d45003d8k.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/ph/'),
  ('0000101829', 'RTX', 'RTX', 88603000000, '2025-12-31'::date, 13060000, '[{"filed": "2026-10-20", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/101829/000010182926000030/rtx-20261020.htm"}, {"filed": "2026-09-15", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/101829/000114036126036662/ef20082011_8k.htm"}, {"filed": "2026-07-23", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/101829/000010182926000025/rtx-20260723.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/rtx/'),
  ('0001571123', 'SAIC', 'SAIC', 7262000000, '2026-01-30'::date, 2008000, '[{"filed": "2026-11-13", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/1571123/000157112326000151/saic-20261113.htm"}, {"filed": "2026-11-02", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/1571123/000157112326000148/saic-20261102.htm"}, {"filed": "2026-10-13", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1571123/000119312526420441/d156029d8k.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/saic/'),
  ('0001260221', 'TDG', 'TransDigm Group', 10557000000, '2026-09-30'::date, 880000, '[{"filed": "2026-11-10", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1260221/000126022126000073/tdg-20261110.htm"}, {"filed": "2026-09-29", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/1260221/000119312526406037/d317756d8k.htm"}, {"filed": "2026-09-28", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/1260221/000126022126000064/tdg-20260928.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/tdg/'),
  ('0001094285', 'TDY', 'Teledyne Technologies', 6115400000, '2025-12-28'::date, 370000, '[{"filed": "2026-10-21", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/1094285/000109428526000055/tdy-20261021.htm"}, {"filed": "2026-09-28", "item": "5.02", "url": "https://www.sec.gov/Archives/edgar/data/1094285/000109428526000050/tdy-20260928.htm"}, {"filed": "2026-08-10", "item": "7.01", "url": "https://www.sec.gov/Archives/edgar/data/1094285/000109428526000047/tdy-20260810.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/tdy/'),
  ('0000217346', 'TXT', 'Textron', 14799000000, '2026-01-03'::date, 5681098, '[{"filed": "2026-11-18", "item": "1.01", "url": "https://www.sec.gov/Archives/edgar/data/217346/000110465926129345/tm2629751d1_8k.htm"}, {"filed": "2026-11-04", "item": "8.01", "url": "https://www.sec.gov/Archives/edgar/data/217346/000110465926122606/tm2628414d4_8k.htm"}, {"filed": "2026-10-29", "item": "2.02", "url": "https://www.sec.gov/Archives/edgar/data/217346/000021734626000043/txt-20261029.htm"}]'::jsonb, 'https://spotthemoney.com/stocks/txt/'),
  ('0000108312', 'WWD', 'Woodward', NULL, NULL, NULL, '[]'::jsonb, NULL)
ON CONFLICT (cik) DO UPDATE SET ticker = EXCLUDED.ticker, name = EXCLUDED.name, revenue = EXCLUDED.revenue,
  revenue_period_end = EXCLUDED.revenue_period_end, lobbying_year = EXCLUDED.lobbying_year,
  events = EXCLUDED.events, stm_url = EXCLUDED.stm_url, as_of = CURRENT_DATE;
UPDATE pub.public_companies SET lobbying_year_label = '2026';
UPDATE pub.public_companies pc SET lobby_pattern = v.pat FROM (VALUES
  ('AIR', '^AAR (CORP|GOVERNMENT)'),
  ('AIT', '^APPLIED INDUSTRIAL TECH'),
  ('ALSN', '^ALLISON TRANSMISSION'),
  ('AME', '^AMETEK'),
  ('BA', '^(THE )?BOEING'),
  ('CMI', '^CUMMINS'),
  ('CR', '^CRANE (CO|COMPANY|AEROSPACE)'),
  ('CW', '^CURTISS.WRIGHT'),
  ('DCO', '^DUCOMMUN'),
  ('DRS', '^(LEONARDO DRS|DRS TECHNOLOGIES)'),
  ('ETN', '^EATON'),
  ('FAST', '^FASTENAL'),
  ('GD', '^GENERAL DYNAMICS'),
  ('GE', '^(GE AEROSPACE|GENERAL ELECTRIC)'),
  ('GM', '^(GENERAL MOTORS|GM DEFENSE)'),
  ('HEI', '^HEICO'),
  ('HII', '^HUNTINGTON INGALLS'),
  ('HONA', '^HONEYWELL AEROSPACE'),
  ('HWM', '^HOWMET'),
  ('HXL', '^HEXCEL'),
  ('IR', '^INGERSOLL RAND INC'),
  ('ITT', '^ITT INC'),
  ('ITW', '^ILLINOIS TOOL WORKS'),
  ('JCI', '^JOHNSON CONTROLS'),
  ('KTOS', '^KRATOS'),
  ('LDOS', '^LEIDOS'),
  ('LHX', '^L3HARRIS'),
  ('LMT', '^LOCKHEED MARTIN'),
  ('LXFR', '^LUXFER'),
  ('MOG.A', '^MOOG'),
  ('MRCY', '^MERCURY SYSTEMS'),
  ('MSM', '^MSC INDUSTRIAL'),
  ('NOC', '^NORTHROP GRUMMAN'),
  ('OSK', '^OSHKOSH'),
  ('PH', '^PARKER.HANNIFIN'),
  ('RTX', '^(RTX|RAYTHEON)'),
  ('SAIC', '^SCIENCE APPLICATIONS'),
  ('TDG', '^TRANSDIGM'),
  ('TDY', '^TELEDYNE'),
  ('TXT', '^TEXTRON'),
  ('WWD', '^WOODWARD')
) AS v(ticker, pat) WHERE pc.ticker = v.ticker;

INSERT INTO pub.parent_rules (ticker, pattern, exclude) VALUES
  ('LMT', '^(LOCKHEED MARTIN|SIKORSKY)', NULL),
  ('RTX', '^(RAYTHEON|RTX|HAMILTON SUNDSTRAND|SIMMONDS PRECISION|PRATT (AND |& )?WHITNEY|COLLINS AEROSPACE|ROCKWELL COLLINS)', 'MARINE'),
  ('GD', '^(GENERAL DYNAMICS|ELECTRIC BOAT|BATH IRON WORKS|NATIONAL STEEL AND SHIPBUILDING|GULFSTREAM AEROSPACE)', NULL),
  ('BA', '^(THE )?BOEING CO', NULL),
  ('NOC', '^NORTHROP GRUMMAN', NULL),
  ('LHX', '^(L3HARRIS|L3 TECHNOLOGIES|L-3 COMMUNICATIONS|AEROJET ROCKETDYNE)', NULL),
  ('HONA', '^HONEYWELL.*(AEROSPACE|AEROSPATIALE)', NULL),
  ('GE', '^(GE AVIATION|GE ENGINE SERVICES|GENERAL ELECTRIC.*(AVIATION|AIRCRAFT ENGINE|AEROSPACE))', NULL),
  ('TXT', '^(BELL TEXTRON|TEXTRON)', 'FAFNIR|CAMCAR|FASTENING|SPRAGUE'),
  ('TDG', '^(TRANSDIGM|LEACH INTERNATIONAL|AEROCONTROLEX|HARTWELL CORP|KORRY ELECTRONICS|DUKES AEROSPACE|AVIONIC INSTRUMENTS|ADAMS RITE AEROSPACE|ADEL WIRING|AVTECHTYLER|BREEZE.EASTERN|MARATHONNORCO|SCHNELLER|SKURKA|TELAIR|WHIPPANY ACTUATION|CHAMPION AEROSPACE|ARMTEC|CEF INDUSTRIES|AMSAFE|BRUCE AEROSPACE|CDA INTERCORP|DATA DEVICE CORP|HARCO|SHIELD RESTRAINT|PEXCO AEROSPACE|ESTERLINE|AEROSONIC|SIMPLEX MANUFACTURING|MASON ELECTRIC|ANGUS ELECTRONICS|ADVANCED INPUT DEVICES)', NULL),
  ('PH', '^(PARKER.HANNIFIN|MEGGITT|LORD CORP)', NULL),
  ('MOG.A', '^MOOG', 'AUTOMOTIVE'),
  ('OSK', '^(OSHKOSH (CORP|DEFENSE|AEROTECH|TRUCK|FIRE)|JLG INDUSTRIES)', NULL),
  ('AIR', '^AAR ', NULL),
  ('CW', '^(CURTISS.WRIGHT|TARGET ROCK)', NULL),
  ('CR', '^(ELDEC|HYDRO.AIRE|CRANE CO)', NULL),
  ('DRS', '^(LEONARDO DRS|DRS )', NULL),
  ('MRCY', '^MERCURY (MISSION )?SYSTEMS', NULL),
  ('HEI', '^(HEICO|JET AVION|DAYTON.GRANGER|THOMPSON SURFACE|SIERRA MICROWAVE|LUCIX|RADIANT POWER|ROBERTSON FUEL|EXXELIA|WENCOR)', NULL),
  ('WWD', '^WOODWARD', 'PHARMA'),
  ('DCO', '^DUCOMMUN', NULL),
  ('ITT', '^(ITT (AEROSPACE|CANNON|ENIDINE|INC|CORPORATION|VEAM)|ENIDINE)', NULL),
  ('AME', '^AMETEK', NULL),
  ('TDY', '^TELEDYNE', 'CONTINENTAL|WATER PIK'),
  ('ETN', '^EATON (AERO|CORP|AVIATION|AEROSPACE)', NULL),
  ('CMI', '^CUMMINS (INC|ENGINE|POWER|AEROSPACE)', NULL),
  ('ALSN', '^ALLISON TRANSMISSION', NULL),
  ('FAST', '^FASTENAL', NULL),
  ('MSM', '^MSC INDUSTRIAL', NULL),
  ('AIT', '^APPLIED INDUSTRIAL TECH', NULL),
  ('ITW', '^(ITW |ILLINOIS TOOL WORKS)', NULL),
  ('IR', '^GARDNER DENVER', NULL),
  ('LXFR', '^LUXFER', NULL),
  ('JCI', '^JOHNSON CONTROLS', 'BATTER'),
  ('SAIC', '^SCIENCE APPLICATIONS INTERNATIONAL', NULL),
  ('LDOS', '^LEIDOS', NULL),
  ('GM', '^GM DEFENSE', NULL),
  ('HII', '^(HUNTINGTON INGALLS|NEWPORT NEWS SHIPBUILDING)', NULL),
  ('HXL', '^HEXCEL', NULL),
  ('HWM', '^HOWMET', NULL),
  ('KTOS', '^KRATOS', NULL)
ON CONFLICT (ticker, pattern) DO UPDATE SET exclude = EXCLUDED.exclude;

CREATE OR REPLACE FUNCTION pub.rebuild_supplier_parent() RETURNS integer
LANGUAGE plpgsql SET search_path = pub, pg_catalog AS $$
DECLARE n integer;
BEGIN
  DELETE FROM pub.supplier_parent;
  INSERT INTO pub.supplier_parent (cage, cik)
  SELECT DISTINCT ON (s.cage) s.cage, pc.cik
  FROM pub.suppliers s
  LEFT JOIN pub.supplier_sam sa USING (cage)
  LEFT JOIN pub.supplier_stats st USING (cage)
  JOIN pub.parent_rules r ON (upper(coalesce(sa.legal_name, s.name)) ~ r.pattern OR upper(s.name) ~ r.pattern)
   AND (r.exclude IS NULL OR (upper(coalesce(sa.legal_name, s.name)) !~ r.exclude AND upper(s.name) !~ r.exclude))
  JOIN pub.public_companies pc ON pc.ticker = r.ticker
  WHERE sa.registration_status = 'Active' OR st.last_award >= date '2021-01-01'
  ORDER BY s.cage, r.ticker;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION pub.rebuild_supplier_parent() FROM PUBLIC, anon, authenticated;

SELECT pub.rebuild_supplier_parent();
