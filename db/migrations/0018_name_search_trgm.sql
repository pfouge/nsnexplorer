-- 0018: search by item name and by everyday ("also called") name (2026-11-15).
--
-- /api/names.json and /search/ match the words of a query against pub.nsns.item_name and against
-- pub.inc_colloquial_names.colloquial_name (reached through pub.nsn_identification.inc) with
-- ILIKE '%word%'. Trigram GIN indexes make that a short index scan instead of a read of the whole table
-- (pub.nsns is about 178,000 rows, pub.inc_colloquial_names about 34,000), and a btree on
-- pub.nsn_identification(inc) makes the INC join cheap. No data changes.
--
-- pg_trgm is a standard Postgres extension and is available on Supabase. No earlier migration creates an
-- extension, so this is the first CREATE EXTENSION in the repo. Supabase normally keeps extensions in the
-- `extensions` schema, so the operator class is looked up in whichever schema the extension lives in
-- instead of relying on search_path. The query itself uses only core operators (ILIKE, LIKE), so it does
-- not need pg_trgm on its search_path at request time.
--
-- Index builds take a write lock on the table for the few seconds they run (178,000 short names);
-- db/migrate.mjs wraps this file in one transaction, so CREATE INDEX CONCURRENTLY is not an option.
-- Re-running is safe (IF NOT EXISTS).

DO $$
DECLARE
  ext_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
      CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
    ELSE
      CREATE EXTENSION pg_trgm;
    END IF;
  END IF;

  SELECT n.nspname INTO ext_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';

  EXECUTE format('CREATE INDEX IF NOT EXISTS nsns_item_name_trgm_idx ON pub.nsns USING gin (item_name %I.gin_trgm_ops)', ext_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS inc_colloquial_name_trgm_idx ON pub.inc_colloquial_names USING gin (colloquial_name %I.gin_trgm_ops)', ext_schema);
END $$;

CREATE INDEX IF NOT EXISTS nsn_identification_inc_idx ON pub.nsn_identification (inc) WHERE inc IS NOT NULL;
