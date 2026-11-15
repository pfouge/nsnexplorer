-- 0016: find the same requirement posted on DIBBS and on SAM.gov (2026-11-15).
--
-- DIBBS stores a solicitation number with dashes (SPE4A5-26-T-1234), SAM.gov prints it without (SPE4A526T1234); the
-- two spellings are different primary keys, so the same requirement is two rows. The site pairs them when the number
-- is equal once everything but letters and digits is dropped (rule and documentation: web/src/lib/sol-twin.ts).
-- This index serves that lookup (one page: one row; the open lists: the SAM rows joined to their DIBBS rows). The
-- expression must stay character-for-character the one in sol-twin.ts (solKeySql); sol-twin.test.ts checks it.
-- No data changes. Plain CREATE INDEX (db/migrate.mjs runs each file in a transaction), a few seconds on ~300k rows.

CREATE INDEX IF NOT EXISTS solicitations_sol_key_idx
  ON pub.solicitations ((regexp_replace(upper(sol_number), '[^A-Z0-9]', '', 'g')));
