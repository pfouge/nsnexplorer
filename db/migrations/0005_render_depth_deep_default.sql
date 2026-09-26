-- Every category renders. /nsn/[nsn]/ pages are now served on request by the
-- Cloudflare Pages Function (no build-time file budget), so the deep/shallow
-- gate that limited the historic catalog to a few FSCs is retired: the build
-- loads every non-excluded FSC, and the DIBBS award lane (which still reads
-- render_depth = 'deep' to decide which award rows to keep) covers all of them.
-- 'excluded' remains available for categories that should never render.
BEGIN;
ALTER TABLE pub.fsc ALTER COLUMN render_depth SET DEFAULT 'deep';
UPDATE pub.fsc SET render_depth = 'deep' WHERE render_depth = 'shallow';
COMMIT;
