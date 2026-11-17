-- 0024_lock_down_api_surface.sql
--
-- Supabase flagged public.schema_migrations (2026-11-14, rls_disabled_in_public): the table
-- db/migrate.mjs creates sat in `public`, which PostgREST exposes, with Supabase's default grants
-- and no row-level security. Anyone holding the site's publishable key (it is public by design,
-- web/src/lib/account-config.ts) could read, change or delete the migration ledger through
-- /rest/v1/schema_migrations; deleting rows would make the next migrate run re-apply old files.
--
-- This file closes that table and the cause: Supabase gives `anon` and `authenticated` every
-- privilege on any new table, sequence or function the migration role creates in `public`.
-- From here on nothing new is reachable through the API unless a migration grants it.
--
-- RULE FOR LATER MIGRATIONS: a new table or function that the account API must reach needs its
-- own `grant ... to authenticated` (or `anon`), as 0009 does. Tables in `public` also need
-- `enable row level security` and a policy.
--
-- The site and the pipelines connect as the owning role, which row-level security does not
-- restrict, so builds, ingest and /api/signup are unaffected. Safe to run more than once.
-- (0023 is taken by the freight and packaging loader, pull request #41.)

-- 1. The migration ledger is internal.
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public;

do $$
declare r text; t record;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.schema_migrations from %I', r);

      -- 2. New objects in `public` start closed to the API roles.
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);

      -- 4. A maintenance function nobody but the pipeline should run.
      execute format('revoke all on function pub.refresh_supplier_stats() from %I', r);
    end if;
  end loop;

  -- 3. Tables that hold email addresses, opt-outs or internal working data: no API role has a
  --    grant on them today; row-level security with no policy keeps them closed even if a grant
  --    is added by mistake later.
  for t in
    select c.oid::regclass as rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relrowsecurity
      and (n.nspname = 'ops' or (n.nspname = 'pub' and c.relname in ('signups', 'supplier_optouts')))
  loop
    execute format('alter table %s enable row level security', t.rel);
  end loop;
end $$;

-- New functions are no longer callable by every role by default (Postgres grants EXECUTE to
-- PUBLIC on creation; this can only be changed for the creating role as a whole, not per schema).
alter default privileges revoke execute on functions from public;
revoke all on function pub.refresh_supplier_stats() from public;
