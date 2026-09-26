-- USAspending award profile URLs are canonical WITHOUT a trailing slash;
-- the slash can break their client-side routing. Trim existing rows
-- (loader fixed in the same commit).
UPDATE pub.contract_actions
SET source_url = left(source_url, -1)
WHERE source_url LIKE 'https://www.usaspending.gov/award/%/';
