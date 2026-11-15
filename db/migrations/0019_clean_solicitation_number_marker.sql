-- 0019: rename the solicitation numbers the old DIBBS parser stored with its attachment marker (2026-11-15).
--
-- Until ingest/dibbs/parse.mjs cleanSolicitation() was added (commit d93d5a9, "Same requirement on DIBBS and SAM.gov
-- counted once..."), rows with attachments were stored as "SPE7M5-27-Q-0118 --" (the "--&raquo;Attachments" marker cut at the
-- raquo left its dashes behind). The parser now stores "SPE7M5-27-Q-0118", so the next ingest would insert a second row
-- for every marked number that is still on DIBBS. This renames the old rows first.
--
-- The rule is exactly cleanSolicitation(): drop a trailing run of two or more hyphens with the whitespace around it, trim
-- (JS \s and String.trim() whitespace), and an empty result means "no number" (such a row is left alone). It is applied
-- once, like the parser applies it: a number the single pass would leave marked ("X -- --") is not touched here.
-- ingest/test/sol-clean-migration.test.mjs proves the SQL below against the JS function.
--
-- pub.solicitations.sol_number is a primary key and both foreign keys to it (pub.price_points, ops.quotes) are plain
-- NO ACTION, not ON UPDATE CASCADE, so the key cannot just be updated. Per renamed number, inside this one transaction:
--   1. insert the clean row as a copy of the marked one (every column, listed from the catalog, so a column added later
--      is copied too; generated columns are left to the server) unless the clean number already exists;
--   2. repoint every foreign key child (found in pg_constraint, not listed by hand) from the marked to the clean number;
--   3. repoint the one plain copy of a solicitation number (public.watchlist_items, kind 'solicitation');
--   4. delete the marked row (the foreign keys are checked again here: a child left behind aborts the whole migration).
-- If the clean number already exists (a fixed-parser ingest got there first) the existing row is kept as it is and the
-- marked row only hands over its children, then goes: the fixed parser re-reads every open RFQ on each crawl, so the
-- clean row is the one that stays current; the marked row can only be older. If several marked spellings map to one
-- clean number ("X --" and "X  --") and no clean row exists, the one with the latest last_seen_at is copied, the others
-- are merged away the same way.
-- Not touched on purpose: price_points.raw and contract_actions.raw ('solicitation' inside the award record; every reader
-- matches it as upper-case letters and digits only, so the marker never mattered), the 0016 index (key drops everything
-- but letters and digits, so a rename does not change it), watchlist snapshots (they hold status/return_by/quantity only).
-- Idempotent: a second run finds no marked row and does nothing. Needs no data from outside the database.

SET LOCAL lock_timeout = '20s';
-- Ingest upserts into pub.solicitations; without this lock an old-parser crawl could add a marked row mid-migration.
-- SHARE ROW EXCLUSIVE lets readers (the site) through and makes writers wait the few milliseconds this takes.
LOCK TABLE pub.solicitations IN SHARE ROW EXCLUSIVE MODE;

-- sol_clean:begin
CREATE OR REPLACE FUNCTION pg_temp.sol_clean(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT nullif(
    btrim(
      regexp_replace(t, E'[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*-{2,}[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$', ''),
      E'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    ),
    '')
$fn$;
-- sol_clean:end

DO $mig$
DECLARE
  v_cols      text;
  v_sel       text;
  fk          record;
  n           bigint;
  v_marked    bigint;
  v_copied    bigint;
  v_srcdiff   bigint;
  v_newer     bigint;
  v_deleted   bigint;
  v_watch     bigint := 0;
BEGIN
  -- Every row whose number changes under the parser rule (and settles after one pass).
  CREATE TEMP TABLE sol_rename ON COMMIT DROP AS
    SELECT s.sol_number AS old, pg_temp.sol_clean(s.sol_number) AS new, s.source, s.last_seen_at, s.updated_at
    FROM pub.solicitations s
    WHERE pg_temp.sol_clean(s.sol_number) IS NOT NULL
      AND pg_temp.sol_clean(s.sol_number) <> s.sol_number
      AND pg_temp.sol_clean(pg_temp.sol_clean(s.sol_number)) = pg_temp.sol_clean(s.sol_number);
  SELECT count(*) INTO v_marked FROM sol_rename;

  -- One marked row per clean number that does not exist yet becomes that clean row.
  CREATE TEMP TABLE sol_survivor ON COMMIT DROP AS
    SELECT DISTINCT ON (r.new) r.old, r.new
    FROM sol_rename r
    WHERE NOT EXISTS (SELECT 1 FROM pub.solicitations c WHERE c.sol_number = r.new)
    ORDER BY r.new, r.last_seen_at DESC NULLS LAST, r.updated_at DESC NULLS LAST, r.old;
  SELECT count(*) INTO v_copied FROM sol_survivor;

  -- Collision bookkeeping (information only): a clean row of another source, or older than the marked row.
  SELECT count(*) INTO v_srcdiff FROM sol_rename r JOIN pub.solicitations c ON c.sol_number = r.new
    WHERE c.source IS DISTINCT FROM r.source;
  SELECT count(*) INTO v_newer FROM sol_rename r JOIN pub.solicitations c ON c.sol_number = r.new
    WHERE r.last_seen_at > c.last_seen_at;

  -- 1. the clean rows: a copy of the marked row, every column from the catalog, raw.solicitation cleaned alike.
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
         string_agg(CASE a.attname
                      WHEN 'sol_number' THEN 'r.new'
                      WHEN 'raw' THEN $x$CASE WHEN jsonb_typeof(s.raw -> 'solicitation') = 'string'
                                               AND pg_temp.sol_clean(s.raw ->> 'solicitation') IS NOT NULL
                                          THEN jsonb_set(s.raw, '{solicitation}', to_jsonb(pg_temp.sol_clean(s.raw ->> 'solicitation')))
                                          ELSE s.raw END$x$
                      ELSE 's.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
    INTO v_cols, v_sel
    FROM pg_attribute a
    WHERE a.attrelid = 'pub.solicitations'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
  EXECUTE format('INSERT INTO pub.solicitations (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM sol_survivor r JOIN pub.solicitations s ON s.sol_number = r.old',
                 v_cols, v_sel);

  -- 2. every foreign key that points at pub.solicitations(sol_number), whatever table it is on.
  FOR fk IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, a.attname AS col, array_length(c.conkey, 1) AS nkeys,
           (c.confkey[1] = (SELECT p.attnum FROM pg_attribute p WHERE p.attrelid = c.confrelid AND p.attname = 'sol_number')) AS on_sol
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'pub.solicitations'::regclass
    ORDER BY 1, 2
  LOOP
    IF fk.nkeys <> 1 OR NOT fk.on_sol THEN
      RAISE EXCEPTION 'migration 0019: foreign key % on % is not a single-column reference to sol_number; handle it by hand', fk.conname, fk.tbl;
    END IF;
    EXECUTE format('UPDATE %s c SET %I = r.new FROM sol_rename r WHERE c.%I = r.old', fk.tbl, fk.col, fk.col);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'migration 0019: % rows of % (%) now point at the clean number', n, fk.tbl, fk.col;
    EXECUTE format('SELECT count(*) FROM %s c JOIN sol_rename r ON c.%I = r.old', fk.tbl, fk.col) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'migration 0019: % rows of % still point at a marked number', n, fk.tbl; END IF;
  END LOOP;

  -- 3. the only plain copy of a solicitation number: a followed solicitation (key); keep the existing item when the
  --    clean one is already on the same list. (The key check allows no spaces, so only "X--" spellings can exist.)
  IF to_regclass('public.watchlist_items') IS NOT NULL THEN
    DELETE FROM public.watchlist_items w USING sol_rename r
     WHERE w.kind = 'solicitation' AND w.key = r.old
       AND (EXISTS (SELECT 1 FROM public.watchlist_items w2 WHERE w2.list_id = w.list_id AND w2.kind = 'solicitation' AND w2.key = r.new)
         OR EXISTS (SELECT 1 FROM public.watchlist_items w3 JOIN sol_rename r3 ON r3.old = w3.key
                     WHERE w3.list_id = w.list_id AND w3.kind = 'solicitation' AND r3.new = r.new AND w3.key < w.key));
    UPDATE public.watchlist_items w SET key = r.new FROM sol_rename r WHERE w.kind = 'solicitation' AND w.key = r.old;
    GET DIAGNOSTICS v_watch = ROW_COUNT;
  END IF;

  -- 4. the marked rows (a child still pointing at one makes the foreign key fail here and rolls everything back).
  DELETE FROM pub.solicitations s USING sol_rename r WHERE s.sol_number = r.old;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_marked THEN RAISE EXCEPTION 'migration 0019: deleted % marked rows, expected %', v_deleted, v_marked; END IF;

  RAISE NOTICE 'migration 0019: % marked numbers: % renamed (copied to the clean number), % merged into an existing clean row (% of them from another source, % with a later last_seen_at than the row kept); % watchlist items repointed',
    v_marked, v_copied, v_marked - v_copied, v_srcdiff, v_newer, v_watch;
END
$mig$;

DROP FUNCTION IF EXISTS pg_temp.sol_clean(text);
