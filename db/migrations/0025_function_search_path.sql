-- 0025_function_search_path.sql
--
-- Gives every function in `public` and `pub` a fixed search_path (Supabase advisor
-- function_search_path_mutable, 30 functions on 2026-11-17). Without one, a function resolves
-- unqualified names through whatever search_path its caller has set. None of these was
-- exploitable through the API as built (they run with the caller's rights and PostgREST fixes
-- the path), but a fixed path removes the question.
--
-- The path is the one these functions have always resolved through, `public, extensions`, with
-- pg_temp last so a temporary object can never shadow a real one. Functions that already set a
-- path (the three SECURITY DEFINER ones in 0009) and functions owned by an extension are left
-- alone. Safe to run more than once.
--
-- RULE FOR LATER MIGRATIONS: declare `set search_path = public, extensions, pg_temp` on every
-- new function (or re-run this block at the end of the migration).
--
-- Cost: a SQL function with a fixed path is no longer inlined by the planner. Checked on
-- production in a rolled-back transaction before applying: every account function exercised
-- (follow for all seven kinds, lists, notes, move, share, copy, feed, cards, delete account).

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'pub') and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;
