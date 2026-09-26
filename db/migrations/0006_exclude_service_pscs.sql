-- USAspending contract actions carry Product/Service Codes; service codes
-- (letters, e.g. J028, R425, Z1AA) are not Federal Supply Classes and must
-- not render as parts categories. Exclude every non-numeric code now and
-- leave the ingest loader to insert future ones as excluded.
BEGIN;
UPDATE pub.fsc SET render_depth = 'excluded' WHERE fsc !~ '^[0-9]{4}$';
COMMIT;
