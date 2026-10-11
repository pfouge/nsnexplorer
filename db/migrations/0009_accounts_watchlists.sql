-- 0009 — Accounts, follows and watchlists, signed in through WorkOS AuthKit (2026-10-11).
--
-- Ported from SpotTheMoney's 0017 and adapted to this site's records (NSNs, suppliers, classes,
-- solicitations, agencies, saved Open-demand searches).
--
-- Who a request is: the WorkOS access token, verified by Supabase through its third-party auth
-- integration (Authentication -> Third-party auth -> WorkOS). The token's `sub` is the WorkOS user
-- id ("user_01H..."), a string, not a Supabase auth.users uuid, so nothing here uses auth.uid():
-- app_user_id() reads `sub` from auth.jwt(). The token template adds "role": "authenticated", which
-- is what lets PostgREST switch to that role.
--
-- The site's Worker never touches these tables directly. It calls the functions below through
-- /rest/v1/rpc/ with the visitor's own token, so row-level security decides what each call can see.
-- Only public_watchlist() and watch_cards() run with definer rights; both return public records
-- only (no account id, no email, no note).
--
-- "What is new" for an item is always a record the site learned of AFTER the item's reviewed_at
-- (fallback added_at), by pub.*.ingested_at, which the loaders set on first insert and never
-- change. Solicitation status / return-by / quantity changes are different: the loaders re-stamp
-- updated_at on every crawl, so it cannot say what changed. For those the item keeps a snapshot
-- (snap) taken when it was followed or last reviewed, and a change is a difference from it.
--
-- This migration applies on a database that has no Supabase roles or auth schema too (the
-- functions that need them bind at call time); the local verifiers add stubs for both.
-- Everything is in `public`, which Supabase's PostgREST exposes. `pub` is NOT exposed, so the
-- select grants on pub tables below are usable only by the functions in this file.

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- ── who is asking ───────────────────────────────────────────────────────────────────────────
create or replace function app_user_id() returns text
language plpgsql stable as $$
begin
  return nullif(coalesce(auth.jwt() ->> 'sub', ''), '');
end $$;

create or replace function app_require_user() returns text
language plpgsql stable as $$
declare uid text := app_user_id();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  return uid;
end $$;

-- ── keys ────────────────────────────────────────────────────────────────────────────────────
-- The slug /agency/<slug>/ uses (web/src/lib/shared.ts slugify).
create or replace function agency_slug(p_name text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(lower(btrim(coalesce(p_name, ''))), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')
$$;

-- A saved Open-demand search is its normalized filter string: filters in a fixed order, only the
-- ones that are set, 'all' when none is. See web/src/lib/saved-search.ts (same rules).
create or replace function search_key(p jsonb) returns text
language sql immutable as $$
  select coalesce(nullif(concat_ws(';',
    case when p ->> 'fsc' is not null then 'fsc=' || lower(p ->> 'fsc') end,
    case when p ->> 'closes' is not null then 'closes=' || (p ->> 'closes') end,
    case when p ->> 'minqty' is not null then 'minqty=' || (p ->> 'minqty') end,
    case when p ->> 'comp' is not null then 'comp=' || (p ->> 'comp') end), ''), 'all')
$$;

create or replace function search_parse(p_key text) returns jsonb
language plpgsql immutable as $$
declare part text; k text; v text; r jsonb := '{}'::jsonb;
begin
  if p_key is null or p_key = 'all' then return r; end if;
  foreach part in array string_to_array(p_key, ';') loop
    k := split_part(part, '=', 1); v := split_part(part, '=', 2);
    if k = 'fsc' and upper(v) ~ '^[A-Z0-9]{4}$' then r := r || jsonb_build_object('fsc', upper(v));
    elsif k = 'closes' and v ~ '^[0-9]{1,3}$' and v::int > 0 then r := r || jsonb_build_object('closes', v::int);
    elsif k = 'minqty' and v ~ '^[0-9]{1,9}$' and v::bigint > 0 then r := r || jsonb_build_object('minqty', v::bigint);
    elsif k = 'comp' and v in ('open', 'restricted') then r := r || jsonb_build_object('comp', v);
    else raise exception 'That saved search is not valid.' using errcode = 'P0001';
    end if;
  end loop;
  return r;
end $$;

-- Normalize and validate one followed page's key. Errors are written for people.
create or replace function watch_norm(p_kind text, p_key text) returns text
language plpgsql immutable as $$
declare k text := btrim(coalesce(p_key, ''));
begin
  if p_kind = 'nsn' then
    k := replace(k, '-', '');
    if k !~ '^[0-9]{13}$' then raise exception 'That is not a 13-digit NSN.' using errcode = 'P0001'; end if;
  elsif p_kind in ('supplier', 'manufacturer') then
    k := upper(k);
    if k !~ '^[A-Z0-9]{5}$' then raise exception 'That is not a CAGE code.' using errcode = 'P0001'; end if;
  elsif p_kind = 'fsc' then
    k := upper(k);
    if k !~ '^[A-Z0-9]{4}$' then raise exception 'That is not a supply class.' using errcode = 'P0001'; end if;
  elsif p_kind = 'solicitation' then
    if k !~ '^[A-Za-z0-9-]{1,80}$' then raise exception 'That is not a solicitation number.' using errcode = 'P0001'; end if;
  elsif p_kind = 'agency' then
    k := lower(k);
    if k !~ '^[a-z0-9]([a-z0-9-]{0,118}[a-z0-9])?$' then raise exception 'That is not an agency.' using errcode = 'P0001'; end if;
  elsif p_kind = 'search' then
    if length(k) > 200 then raise exception 'That saved search is not valid.' using errcode = 'P0001'; end if;
    k := search_key(search_parse(lower(k)));
  else
    raise exception 'Unknown kind.' using errcode = 'P0001';
  end if;
  return k;
end $$;

-- Same, but null instead of an error (cards skip what they cannot read).
create or replace function watch_norm_safe(p_kind text, p_key text) returns text
language plpgsql immutable as $$
begin
  return watch_norm(p_kind, p_key);
exception when others then
  return null;
end $$;

-- AMC / AMSC -> competition, the same rule as competitionOf() in web/src/lib/shared.ts.
create or replace function competition_of(p_amc text, p_amsc text) returns text
language sql immutable as $$
  select case when p_amc in ('1', '2') then 'open'
              when p_amc in ('3', '4', '5') then 'restricted'
              when p_amsc = 'G' then 'open'
              else 'unknown' end
$$;

-- ── tables ──────────────────────────────────────────────────────────────────────────────────
create table accounts (
    id           text primary key check (id ~ '^[A-Za-z0-9_]{3,64}$'),   -- WorkOS user id
    email        text check (email is null or length(email) <= 320),
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table watchlists (
    id          uuid primary key default gen_random_uuid(),
    account_id  text not null references accounts(id) on delete cascade,
    name        text not null default 'My watchlist' check (length(btrim(name)) between 1 and 80),
    is_default  boolean not null default false,
    is_public   boolean not null default false,
    slug        text unique check (slug ~ '^[a-z0-9]{12}$'),                -- set while shared
    position    int not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    check (is_public = (slug is not null))
);
create index watchlists_account_idx on watchlists(account_id);
create unique index watchlists_one_default on watchlists(account_id) where is_default;

-- kind + key name the page being followed (see watch_norm for the key rules):
--   nsn 13 digits | supplier CAGE | manufacturer CAGE | fsc class | solicitation number
--   agency slug (as /agency/<slug>/) | search normalized filter string
create table watchlist_items (
    list_id     uuid not null references watchlists(id) on delete cascade,
    kind        text not null check (kind in ('nsn', 'supplier', 'manufacturer', 'fsc', 'solicitation', 'agency', 'search')),
    key         text not null check (watch_norm(kind, key) = key),
    label       text check (label is null or length(label) <= 200),
    note        text check (note is null or length(note) <= 500),
    position    int not null default 0,
    added_at    timestamptz not null default now(),
    reviewed_at timestamptz,
    snap        jsonb,                                                      -- solicitation state at follow / review
    primary key (list_id, kind, key)
);
create index watchlist_items_key_idx on watchlist_items(kind, key);

alter table accounts        enable row level security;
alter table watchlists      enable row level security;
alter table watchlist_items enable row level security;

create policy own_account on accounts
    for all to authenticated using (id = (select app_user_id())) with check (id = (select app_user_id()));
create policy own_watchlists on watchlists
    for all to authenticated using (account_id = (select app_user_id())) with check (account_id = (select app_user_id()));
create policy own_watchlist_items on watchlist_items
    for all to authenticated
    using (list_id in (select id from watchlists where account_id = (select app_user_id())))
    with check (list_id in (select id from watchlists where account_id = (select app_user_id())));

revoke all on accounts, watchlists, watchlist_items from anon;
grant select, insert, update, delete on accounts, watchlists, watchlist_items to authenticated;

-- The feed reads the public record tables as the signed-in visitor (watch_cards and
-- public_watchlist use definer rights instead, so anon needs nothing). Only the tables the
-- feed and search read, and only select. `pub` is not an exposed PostgREST schema.
grant usage on schema public to anon, authenticated;
grant usage on schema pub to authenticated;
grant select on pub.solicitations, pub.price_points, pub.part_numbers, pub.contract_actions,
                pub.nsns, pub.suppliers, pub.agencies, pub.amsc_observations to authenticated;

-- If the project turned on automatic row-level security for new tables, pub tables would read as
-- empty for `authenticated`. Give each a plain read policy in that case (a no-op otherwise).
do $$
declare t text;
begin
  foreach t in array array['solicitations', 'price_points', 'part_numbers', 'contract_actions',
                           'nsns', 'suppliers', 'agencies', 'amsc_observations'] loop
    if (select relrowsecurity from pg_class where oid = ('pub.' || t)::regclass)
       and not exists (select 1 from pg_policies where schemaname = 'pub' and tablename = t and policyname = 'accounts_read') then
      execute format('create policy accounts_read on pub.%I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- ── indexes the feed and cards need (checked against 0001-0008: none of these existed) ──────
create index if not exists solicitations_fsc_ingested_idx on pub.solicitations (fsc, ingested_at);
create index if not exists solicitations_ingested_idx on pub.solicitations (ingested_at);
create index if not exists price_points_sol_number_idx on pub.price_points (sol_number) where sol_number is not null;
create index if not exists price_points_cage_ingested_idx on pub.price_points (cage, ingested_at);
create index if not exists price_points_nsn_ingested_idx on pub.price_points (nsn, ingested_at);
create index if not exists price_points_agency_ingested_idx on pub.price_points (agency_id, ingested_at);
create index if not exists part_numbers_cage_idx on pub.part_numbers (cage, nsn);
create index if not exists contract_actions_agency_ingested_idx on pub.contract_actions (agency_id, ingested_at);
create index if not exists contract_actions_uei_ingested_idx on pub.contract_actions (recipient_uei, ingested_at) where recipient_uei is not null;
create index if not exists agencies_slug_idx on pub.agencies (agency_slug(name));

-- ── limits ──────────────────────────────────────────────────────────────────────────────────
create or replace function watchlist_limits() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'watchlists' then
    if (select count(*) from watchlists where account_id = new.account_id) >= 20 then
      raise exception 'You can have up to 20 watchlists.' using errcode = 'P0001';
    end if;
  else
    if (select count(*) from watchlist_items where list_id = new.list_id) >= 500 then
      raise exception 'A watchlist can hold up to 500 items.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger watchlists_limit before insert on watchlists for each row execute function watchlist_limits();
create trigger watchlist_items_limit before insert on watchlist_items for each row execute function watchlist_limits();

-- ── what is new for one item ────────────────────────────────────────────────────────────────
-- The state of a solicitation as the page reports it: an open row past its return-by is expired.
create or replace function sol_snapshot(p_sol text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
           'status', case when s.status = 'open' and s.return_by < current_date then 'expired' else s.status end,
           'return_by', s.return_by, 'quantity', s.quantity)
  from pub.solicitations s where s.sol_number = p_sol
$$;

create or replace function watch_snap(p_kind text, p_key text) returns jsonb
language sql stable as $$
  select case when p_kind = 'solicitation' then sol_snapshot(p_key) end
$$;

-- Open solicitations that make up the /open/ cards matching a saved search, one row per
-- solicitation. A card is an NSN: open = status 'open' and not past its return-by; the card's
-- closing date is its earliest return-by, its quantity the sum over its open solicitations, its
-- competition the latest AMC / AMSC on record. Same rules as buildSolicitationCards().
create or replace function search_sols(p jsonb)
returns table (sol_number text, nsn text, item text, issued_on date, return_by date, quantity numeric,
               ingested_at timestamptz, source text, url text)
language sql stable as $$
  with open_sol as (
    select s.* from pub.solicitations s
    where s.status = 'open' and s.nsn is not null
      and (s.return_by is null or s.return_by >= current_date)
      and (p ->> 'fsc' is null or s.fsc = (p ->> 'fsc')::bpchar)
  ),
  card as (
    select o.nsn, min(o.return_by) as next_close, sum(coalesce(o.quantity, 0)) as qty
    from open_sol o group by o.nsn
  ),
  keep as (
    select c.nsn from card c
    left join lateral (select ao.amc, ao.amsc from pub.amsc_observations ao
                       where ao.nsn = c.nsn order by ao.observed_on desc limit 1) a on true
    where (p ->> 'closes' is null or (c.next_close is not null and c.next_close - current_date <= (p ->> 'closes')::int))
      and (p ->> 'minqty' is null or c.qty >= (p ->> 'minqty')::numeric)
      and (p ->> 'comp' is null or competition_of(a.amc::text, a.amsc::text) = p ->> 'comp')
  )
  select o.sol_number, o.nsn::text, coalesce(n.item_name, o.nomenclature), o.issued_on, o.return_by, o.quantity,
         o.ingested_at, o.source, o.source_url
  from open_sol o
  join keep k on k.nsn = o.nsn
  left join pub.nsns n on n.nsn = o.nsn
$$;

create or replace function search_matches(params jsonb, since timestamptz default null) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'open_now', count(distinct m.nsn),
    'solicitations', count(*),
    'new_since', count(*) filter (where since is not null and m.ingested_at > since))
  from search_sols(coalesce(params, '{}'::jsonb)) m
$$;

-- The records an item has gained since p_since, newest first within each source, at most
-- p_limit per source. Every row is something the loaders ingested after p_since.
create or replace function item_event_rows(p_kind text, p_key text, p_since timestamptz, p_snap jsonb, p_limit int)
returns table (ev_type text, ev_at timestamptz, ev jsonb)
language plpgsql stable as $$
begin
  if p_kind = 'nsn' then
    return query
      select 'rfq'::text, s.ingested_at,
             jsonb_build_object('sol', s.sol_number, 'nsn', s.nsn::text, 'item', coalesce(n.item_name, s.nomenclature),
                                'issued_on', s.issued_on, 'return_by', s.return_by, 'quantity', s.quantity,
                                'status', s.status, 'source', s.source, 'url', s.source_url)
      from pub.solicitations s left join pub.nsns n on n.nsn = s.nsn
      where s.nsn = p_key::bpchar and s.ingested_at > p_since
      order by s.ingested_at desc limit p_limit;
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price, 'quantity', p.quantity,
                                'cage', p.cage::text, 'supplier', su.name, 'sol', p.sol_number, 'url', p.source_url)
      from pub.price_points p left join pub.suppliers su on su.cage = p.cage
      where p.nsn = p_key::bpchar and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'supplier' then
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'item', n.item_name, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price,
                                'quantity', p.quantity, 'sol', p.sol_number, 'url', p.source_url)
      from pub.price_points p left join pub.nsns n on n.nsn = p.nsn
      where p.cage = p_key::bpchar and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;
    return query
      select 'contract_action'::text, ca.ingested_at,
             jsonb_build_object('action_date', ca.action_date, 'obligation', ca.obligation, 'description', ca.description,
                                'agency', ag.name, 'piid', ca.piid, 'url', ca.source_url)
      from pub.contract_actions ca left join pub.agencies ag on ag.agency_id = ca.agency_id
      where ca.recipient_uei is not null
        and ca.recipient_uei = (select su.uei from pub.suppliers su where su.cage = p_key::bpchar)
        and ca.ingested_at > p_since
      order by ca.ingested_at desc limit p_limit;

  elsif p_kind = 'manufacturer' then
    return query
      select 'rfq'::text, s.ingested_at,
             jsonb_build_object('sol', s.sol_number, 'nsn', s.nsn::text, 'item', coalesce(n.item_name, s.nomenclature),
                                'issued_on', s.issued_on, 'return_by', s.return_by, 'quantity', s.quantity,
                                'status', s.status, 'source', s.source, 'url', s.source_url)
      from (select distinct pn.nsn from pub.part_numbers pn where pn.cage = p_key::bpchar) m
      join pub.solicitations s on s.nsn = m.nsn
      left join pub.nsns n on n.nsn = s.nsn
      where s.ingested_at > p_since
      order by s.ingested_at desc limit p_limit;

  elsif p_kind = 'fsc' then
    return query
      select 'rfq'::text, s.ingested_at,
             jsonb_build_object('sol', s.sol_number, 'nsn', s.nsn::text, 'item', coalesce(n.item_name, s.nomenclature),
                                'issued_on', s.issued_on, 'return_by', s.return_by, 'quantity', s.quantity,
                                'status', s.status, 'source', s.source, 'url', s.source_url)
      from pub.solicitations s left join pub.nsns n on n.nsn = s.nsn
      where s.fsc = p_key::bpchar and s.ingested_at > p_since
      order by s.ingested_at desc limit p_limit;
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'item', n.item_name, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price,
                                'quantity', p.quantity, 'cage', p.cage::text, 'supplier', su.name, 'sol', p.sol_number, 'url', p.source_url)
      from pub.nsns n
      join pub.price_points p on p.nsn = n.nsn
      left join pub.suppliers su on su.cage = p.cage
      where n.fsc = p_key::bpchar and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'solicitation' then
    if p_snap is not null then
      return query
        select 'changed'::text, s.updated_at,
               jsonb_build_object('sol', s.sol_number,
                                  'status', case when s.status = 'open' and s.return_by < current_date then 'expired' else s.status end,
                                  'return_by', s.return_by, 'quantity', s.quantity,
                                  'was_status', p_snap ->> 'status', 'was_return_by', p_snap ->> 'return_by',
                                  'was_quantity', p_snap -> 'quantity', 'url', s.source_url)
        from pub.solicitations s
        where s.sol_number = p_key
          and ((case when s.status = 'open' and s.return_by < current_date then 'expired' else s.status end) is distinct from p_snap ->> 'status'
               or s.return_by is distinct from nullif(p_snap ->> 'return_by', '')::date
               or s.quantity is distinct from nullif(p_snap ->> 'quantity', '')::numeric)
        limit p_limit;
    end if;
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price, 'quantity', p.quantity,
                                'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
      from pub.price_points p left join pub.suppliers su on su.cage = p.cage
      where p.sol_number = p_key and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'agency' then
    return query
      select 'contract_action'::text, ca.ingested_at,
             jsonb_build_object('action_date', ca.action_date, 'obligation', ca.obligation, 'description', ca.description,
                                'recipient', ca.recipient_name, 'piid', ca.piid, 'url', ca.source_url)
      from pub.agencies a
      join pub.contract_actions ca on ca.agency_id = a.agency_id
      where agency_slug(a.name) = p_key and ca.ingested_at > p_since
      order by ca.ingested_at desc limit p_limit;
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'item', n.item_name, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price,
                                'quantity', p.quantity, 'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
      from pub.agencies a
      join pub.price_points p on p.agency_id = a.agency_id
      left join pub.nsns n on n.nsn = p.nsn
      left join pub.suppliers su on su.cage = p.cage
      where agency_slug(a.name) = p_key and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'search' then
    return query
      select 'rfq'::text, m.ingested_at,
             jsonb_build_object('sol', m.sol_number, 'nsn', m.nsn, 'item', m.item, 'issued_on', m.issued_on,
                                'return_by', m.return_by, 'quantity', m.quantity, 'status', 'open', 'source', m.source, 'url', m.url)
      from search_sols(search_parse(p_key)) m
      where m.ingested_at > p_since
      order by m.ingested_at desc limit p_limit;
  end if;
end $$;

create or replace function item_changed(p_kind text, p_key text, p_since timestamptz, p_snap jsonb) returns boolean
language sql stable as $$
  select exists (select 1 from item_event_rows(p_kind, p_key, p_since, p_snap, 1))
$$;

-- {count, events[]} for one item: the newest p_cap events across its sources. count stops at
-- 100 per source, so "100 or more" is the most it ever claims.
create or replace function item_events(p_kind text, p_key text, p_since timestamptz, p_snap jsonb, p_cap int default 8) returns jsonb
language sql stable as $$
  with q as (select * from item_event_rows(p_kind, p_key, p_since, p_snap, 100))
  select jsonb_build_object(
    'count', (select count(*) from q),
    'events', coalesce((select jsonb_agg(e.ev || jsonb_build_object('type', e.ev_type, 'at', e.ev_at) order by e.ev_at desc)
                        from (select * from q order by ev_at desc limit greatest(p_cap, 0)) e), '[]'::jsonb))
$$;

-- ── the API (called by the site's Worker through /rest/v1/rpc/) ─────────────────────────────

-- Internal: make sure the account and its default list exist.
create or replace function account_ensure(p_email text default null) returns text
language plpgsql as $$
declare uid text := app_require_user();
begin
  insert into accounts (id, email) values (uid, nullif(btrim(p_email), ''))
  on conflict (id) do update set email = coalesce(excluded.email, accounts.email), last_seen_at = now();
  if not exists (select 1 from watchlists where account_id = uid and is_default) then
    insert into watchlists (account_id, name, is_default) values (uid, 'My watchlist', true);
  end if;
  return uid;
end $$;

-- The signed-in visitor's whole state: lists with their items, and how many items changed.
create or replace function my_state() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'account', (select jsonb_build_object('email', a.email, 'created_at', a.created_at) from accounts a where a.id = app_user_id()),
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'name', w.name, 'is_default', w.is_default, 'is_public', w.is_public, 'slug', w.slug,
               'items', coalesce((select jsonb_agg(jsonb_build_object(
                                         'kind', i.kind, 'key', i.key, 'label', i.label, 'note', i.note,
                                         'added_at', i.added_at, 'reviewed_at', i.reviewed_at)
                                         order by i.position, i.added_at)
                                  from watchlist_items i where i.list_id = w.id), '[]'::jsonb))
             order by w.is_default desc, w.position, w.created_at)
      from watchlists w where w.account_id = app_user_id()), '[]'::jsonb),
    'new_count', (select count(*) from watchlist_items i join watchlists w on w.id = i.list_id
                  where w.account_id = app_user_id()
                    and item_changed(i.kind, i.key, coalesce(i.reviewed_at, i.added_at), i.snap)))
$$;

create or replace function account_touch(p_email text default null) returns jsonb
language plpgsql as $$
begin
  perform account_ensure(p_email);
  return my_state();
end $$;

-- Follow or unfollow. Without p_list, the default list.
create or replace function follow(p_kind text, p_key text, p_label text default null, p_on boolean default true,
                                  p_list uuid default null) returns jsonb
language plpgsql as $$
declare uid text := account_ensure(null); lid uuid; k text := watch_norm(p_kind, p_key);
begin
  lid := coalesce(p_list, (select id from watchlists where account_id = uid and is_default));
  if not exists (select 1 from watchlists where id = lid and account_id = uid) then
    raise exception 'No such watchlist.' using errcode = 'P0002';
  end if;
  if p_on then
    insert into watchlist_items (list_id, kind, key, label, snap, position)
    values (lid, p_kind, k, nullif(left(btrim(p_label), 200), ''), watch_snap(p_kind, k),
            (select coalesce(max(position), 0) + 1 from watchlist_items where list_id = lid))
    on conflict (list_id, kind, key) do update set label = coalesce(excluded.label, watchlist_items.label);
  else
    delete from watchlist_items where list_id = lid and kind = p_kind and key = k;
  end if;
  return my_state();
end $$;

-- Create, rename, share or unshare, delete a list. Sharing makes a fresh slug; unsharing drops it,
-- so a link that was handed out stops working.
create or replace function list_save(p_id uuid default null, p_name text default null, p_public boolean default null,
                                     p_delete boolean default false) returns jsonb
language plpgsql as $$
declare uid text := account_ensure(null); w watchlists;
begin
  if p_id is null then
    insert into watchlists (account_id, name, position)
    values (uid, coalesce(nullif(btrim(p_name), ''), 'New watchlist'),
            (select coalesce(max(position), 0) + 1 from watchlists where account_id = uid));
    return my_state();
  end if;
  select * into w from watchlists where id = p_id and account_id = uid;
  if not found then raise exception 'No such watchlist.' using errcode = 'P0002'; end if;
  if p_delete then
    if w.is_default then raise exception 'Your first watchlist cannot be deleted.' using errcode = 'P0001'; end if;
    delete from watchlists where id = p_id;
    return my_state();
  end if;
  update watchlists set
    name = coalesce(nullif(btrim(p_name), ''), name),
    is_public = case when p_public is null then is_public else p_public end,
    slug = case when p_public is true and slug is null
                  then substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 12)
                when p_public is false then null else slug end,
    updated_at = now()
  where id = p_id;
  return my_state();
end $$;

-- Move an item from one of your lists to another (its review state moves with it).
create or replace function item_move(p_kind text, p_key text, p_from uuid, p_to uuid) returns jsonb
language plpgsql as $$
declare uid text := app_require_user(); k text := watch_norm(p_kind, p_key);
begin
  if not exists (select 1 from watchlists where id = p_to and account_id = uid)
     or not exists (select 1 from watchlists where id = p_from and account_id = uid) then
    raise exception 'No such watchlist.' using errcode = 'P0002';
  end if;
  if p_from <> p_to then
    insert into watchlist_items (list_id, kind, key, label, note, position, added_at, reviewed_at, snap)
    select p_to, kind, key, label, note, (select coalesce(max(position), 0) + 1 from watchlist_items where list_id = p_to),
           added_at, reviewed_at, snap
    from watchlist_items where list_id = p_from and kind = p_kind and key = k
    on conflict do nothing;
    delete from watchlist_items where list_id = p_from and kind = p_kind and key = k;
  end if;
  return my_state();
end $$;

-- A private note on one item.
create or replace function item_note(p_list uuid, p_kind text, p_key text, p_note text) returns jsonb
language plpgsql as $$
declare uid text := app_require_user(); k text := watch_norm(p_kind, p_key);
begin
  update watchlist_items i set note = nullif(left(btrim(p_note), 500), '')
  from watchlists w
  where w.id = i.list_id and w.account_id = uid and i.list_id = p_list and i.kind = p_kind and i.key = k;
  if not found then raise exception 'No such item.' using errcode = 'P0002'; end if;
  return my_state();
end $$;

-- Changes per item since it was last reviewed (items with none are left out), newest first.
create or replace function watch_feed(p_per int default 8) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'changed', count(*),
    'items', coalesce(jsonb_agg(x.item order by x.latest desc), '[]'::jsonb))
  from (
    select jsonb_build_object('list', i.list_id, 'kind', i.kind, 'key', i.key, 'label', i.label,
                              'since', coalesce(i.reviewed_at, i.added_at),
                              'count', (e.r ->> 'count')::int, 'events', e.r -> 'events') as item,
           (e.r -> 'events' -> 0 ->> 'at')::timestamptz as latest
    from watchlist_items i
    join watchlists w on w.id = i.list_id and w.account_id = app_user_id()
    cross join lateral (select item_events(i.kind, i.key, coalesce(i.reviewed_at, i.added_at), i.snap,
                                           least(greatest(coalesce(p_per, 8), 1), 50)) as r) e
    where (e.r ->> 'count')::int > 0
  ) x
$$;

-- Mark reviewed: one item (kind + key), or every item of a list (kind and key null), or of every
-- list of yours (list null too). Solicitations take a fresh snapshot.
create or replace function mark_reviewed(p_list uuid default null, p_kind text default null, p_key text default null) returns jsonb
language plpgsql as $$
declare uid text := app_require_user(); k text;
begin
  if (p_kind is null) <> (p_key is null) then
    raise exception 'Name both the kind and the key, or neither.' using errcode = 'P0001';
  end if;
  if p_kind is not null then k := watch_norm(p_kind, p_key); end if;
  if p_list is not null and not exists (select 1 from watchlists where id = p_list and account_id = uid) then
    raise exception 'No such watchlist.' using errcode = 'P0002';
  end if;
  update watchlist_items i set reviewed_at = now(), snap = watch_snap(i.kind, i.key)
  from watchlists w
  where w.id = i.list_id and w.account_id = uid
    and (p_list is null or i.list_id = p_list)
    and (p_kind is null or (i.kind = p_kind and i.key = k));
  update accounts set last_seen_at = now() where id = uid;
  return my_state();
end $$;

-- Copy a shared list into a new list of your own. Items start unreviewed-as-of-now.
create or replace function list_copy(p_slug text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid text := account_ensure(null); src watchlists; nid uuid;
begin
  select * into src from watchlists where slug = p_slug and is_public;
  if not found then raise exception 'That shared watchlist no longer exists.' using errcode = 'P0002'; end if;
  insert into watchlists (account_id, name, position)
  values (uid, left('Copy of ' || src.name, 80), (select coalesce(max(position), 0) + 1 from watchlists where account_id = uid))
  returning id into nid;
  insert into watchlist_items (list_id, kind, key, label, position, snap)
  select nid, kind, key, label, position, watch_snap(kind, key) from watchlist_items where list_id = src.id;
  return my_state();
end $$;

-- Delete the account and everything tied to it (the WorkOS user is deleted by the Worker).
create or replace function account_delete() returns jsonb
language plpgsql as $$
declare uid text := app_require_user();
begin
  delete from accounts where id = uid;
  return jsonb_build_object('deleted', true);
end $$;

-- A shared list as anyone may see it: name and items. No account id, no email, no notes.
create or replace function public_watchlist(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'name', w.name, 'updated_at', w.updated_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'key', i.key, 'label', i.label)
                                        order by i.position, i.added_at)
                       from watchlist_items i where i.list_id = w.id), '[]'::jsonb))
  from watchlists w where w.slug = p_slug and w.is_public
$$;

-- ── cards ───────────────────────────────────────────────────────────────────────────────────
-- One round trip for a whole list: {"<kind>:<key>": card}. Definer rights because anonymous
-- visitors read shared lists too; it returns public records only and nothing about any account.
-- items: [{kind, key, since?}] (at most 200). `since` only matters to saved searches ("new since").
-- Items the records do not know are left out; the page then shows the row without a card.
create or replace function watch_cards(items jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if items is null or jsonb_typeof(items) <> 'array' then
    raise exception 'items must be a list' using errcode = 'P0001';
  end if;
  if jsonb_array_length(items) > 200 then
    raise exception 'Ask for at most 200 items at a time.' using errcode = 'P0001';
  end if;
  with it as (
    select distinct e ->> 'kind' as kind,
           watch_norm_safe(e ->> 'kind', e ->> 'key') as key,
           case when (e ->> 'since') ~ '^\d{4}-\d{2}-\d{2}' then (e ->> 'since')::timestamptz end as since
    from jsonb_array_elements(items) e
  ),
  cards as (
    -- nsn: name, class, last 12 award prices, latest award, open RFQs, coding
    select 'nsn:' || n.nsn as k, jsonb_build_object(
      'name', n.item_name, 'fsc', n.fsc::text, 'fsc_name', f.name,
      'amc', a.amc::text, 'amsc', a.amsc::text,
      'award_count', (select count(*) from pub.price_points p where p.nsn = n.nsn),
      'prices', coalesce((select jsonb_agg(jsonb_build_array(x.awarded_on, x.unit_price) order by x.awarded_on, x.id)
                          from (select p.id, p.awarded_on, p.unit_price from pub.price_points p where p.nsn = n.nsn
                                order by p.awarded_on desc, p.id desc limit 12) x), '[]'::jsonb),
      'latest', (select jsonb_build_object('date', p.awarded_on, 'unit_price', p.unit_price, 'quantity', p.quantity,
                                           'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
                 from pub.price_points p left join pub.suppliers su on su.cage = p.cage
                 where p.nsn = n.nsn order by p.awarded_on desc, p.id desc limit 1),
      'open_rfqs', (select count(*) from pub.solicitations s
                    where s.nsn = n.nsn and s.status = 'open' and (s.return_by is null or s.return_by >= current_date)),
      'next_return_by', (select min(s.return_by) from pub.solicitations s
                         where s.nsn = n.nsn and s.status = 'open' and s.return_by >= current_date)) as card
    from it join pub.nsns n on n.nsn = it.key::bpchar and it.kind = 'nsn'
    left join pub.fsc f on f.fsc = n.fsc
    left join lateral (select ao.amc, ao.amsc from pub.amsc_observations ao where ao.nsn = n.nsn
                       order by ao.observed_on desc limit 1) a on true
    union all
    -- supplier: name and place, awards per month for 12 months, latest 5 wins
    select 'supplier:' || su.cage, jsonb_build_object(
      'name', su.name, 'city', su.city, 'state', su.state, 'country', su.country,
      'award_count', (select count(*) from pub.price_points p where p.cage = su.cage),
      'months', (select jsonb_agg(jsonb_build_array(to_char(m.mo, 'YYYY-MM'), coalesce(c.n, 0), coalesce(c.v, 0)) order by m.mo)
                 from generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date),
                                      interval '1 month') m(mo)
                 left join (select date_trunc('month', p.awarded_on) as mo, count(*) as n,
                                   sum(coalesce(p.total_value, p.unit_price * p.quantity)) as v
                            from pub.price_points p
                            where p.cage = su.cage and p.awarded_on >= date_trunc('month', current_date) - interval '11 months'
                            group by 1) c on c.mo = m.mo),
      'wins', coalesce((select jsonb_agg(jsonb_build_object('date', x.awarded_on, 'nsn', x.nsn::text, 'item', x.item_name,
                                                            'unit_price', x.unit_price, 'quantity', x.quantity, 'url', x.source_url)
                                         order by x.awarded_on desc, x.id desc)
                        from (select p.id, p.awarded_on, p.nsn, n.item_name, p.unit_price, p.quantity, p.source_url
                              from pub.price_points p left join pub.nsns n on n.nsn = p.nsn
                              where p.cage = su.cage order by p.awarded_on desc, p.id desc limit 5) x), '[]'::jsonb))
    from it join pub.suppliers su on su.cage = it.key::bpchar and it.kind = 'supplier'
    union all
    -- manufacturer: part numbers, open RFQs on their parts, latest 5 such RFQs
    select 'manufacturer:' || it.key, jsonb_build_object(
      'name', (select su.name from pub.suppliers su where su.cage = it.key::bpchar),
      'part_count', (select count(*) from (select distinct pn.nsn, pn.part_number from pub.part_numbers pn where pn.cage = it.key::bpchar) d),
      'nsn_count', (select count(distinct pn.nsn) from pub.part_numbers pn where pn.cage = it.key::bpchar),
      'open_rfqs', (select count(*) from (select distinct pn.nsn from pub.part_numbers pn where pn.cage = it.key::bpchar) m
                    join pub.solicitations s on s.nsn = m.nsn
                    where s.status = 'open' and (s.return_by is null or s.return_by >= current_date)),
      'rfqs', coalesce((select jsonb_agg(jsonb_build_object('sol', x.sol_number, 'nsn', x.nsn::text, 'item', x.item,
                                                            'return_by', x.return_by, 'quantity', x.quantity, 'url', x.source_url)
                                         order by x.issued_on desc nulls last, x.sol_number)
                        from (select s.sol_number, s.nsn, coalesce(n.item_name, s.nomenclature) as item, s.return_by, s.quantity,
                                     s.source_url, s.issued_on
                              from (select distinct pn.nsn from pub.part_numbers pn where pn.cage = it.key::bpchar) m
                              join pub.solicitations s on s.nsn = m.nsn
                              left join pub.nsns n on n.nsn = s.nsn
                              where s.status = 'open' and (s.return_by is null or s.return_by >= current_date)
                              order by s.issued_on desc nulls last, s.sol_number limit 5) x), '[]'::jsonb))
    from it where it.kind = 'manufacturer'
      and exists (select 1 from pub.part_numbers pn where pn.cage = it.key::bpchar)
    union all
    -- fsc: name, open now, posted in the last 7 days, posted per week for 12 weeks
    select 'fsc:' || f.fsc, jsonb_build_object(
      'name', f.name,
      -- which page exists for the class: /fsc/<fsc>/ only for deep classes, /open/<fsc>/ for any listed
      -- class with a solicitation on record (the same rule as the supplier page's class links)
      'deep', f.render_depth = 'deep',
      'has_open', (f.render_depth <> 'excluded' and f.fsc ~ '^[0-9]{4}$'
                   and exists (select 1 from pub.solicitations s where s.fsc = f.fsc)),
      'open_now', (select count(*) from pub.solicitations s
                   where s.fsc = f.fsc and s.status = 'open' and (s.return_by is null or s.return_by >= current_date)),
      'posted_7d', (select count(*) from pub.solicitations s where s.fsc = f.fsc and s.issued_on >= current_date - 7),
      'weeks', (select jsonb_agg(jsonb_build_array(to_char(w.wk, 'YYYY-MM-DD'), coalesce(c.n, 0)) order by w.wk)
                from generate_series(date_trunc('week', current_date) - interval '11 weeks', date_trunc('week', current_date),
                                     interval '1 week') w(wk)
                left join (select date_trunc('week', s.issued_on) as wk, count(*) as n from pub.solicitations s
                           where s.fsc = f.fsc and s.issued_on >= date_trunc('week', current_date) - interval '11 weeks'
                           group by 1) c on c.wk = w.wk))
    from it join pub.fsc f on f.fsc = it.key::bpchar and it.kind = 'fsc'
    union all
    -- solicitation: NSN, item, quantity, dates, status; the award when one is posted
    select 'solicitation:' || s.sol_number, jsonb_build_object(
      'nsn', s.nsn::text, 'item', coalesce(n.item_name, s.nomenclature), 'quantity', s.quantity, 'unit', s.unit_of_issue,
      'issued_on', s.issued_on, 'return_by', s.return_by,
      'status', case when s.status = 'open' and s.return_by < current_date then 'expired' else s.status end,
      'source', s.source, 'url', s.source_url,
      'award', (select jsonb_build_object('date', p.awarded_on, 'unit_price', p.unit_price, 'quantity', p.quantity,
                                          'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
                from pub.price_points p left join pub.suppliers su on su.cage = p.cage
                where p.sol_number = s.sol_number order by p.awarded_on desc, p.id desc limit 1))
    from it join pub.solicitations s on s.sol_number = it.key and it.kind = 'solicitation'
    left join pub.nsns n on n.nsn = s.nsn
    union all
    -- agency: name, contract actions and awards in the last 90 days (count, value), latest 5 actions
    select 'agency:' || it.key, jsonb_build_object(
      'name', g.name, 'abbreviation', g.abbreviation,
      'actions_90d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(ca.obligation), 0))
                      from pub.contract_actions ca where ca.agency_id = any (g.ids) and ca.action_date >= current_date - 90),
      'awards_90d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(p.total_value, p.unit_price * p.quantity)), 0))
                     from pub.price_points p where p.agency_id = any (g.ids) and p.awarded_on >= current_date - 90),
      'latest', coalesce((select jsonb_agg(jsonb_build_object('date', x.action_date, 'recipient', x.recipient_name,
                                                              'description', x.description, 'obligation', x.obligation, 'url', x.source_url)
                                           order by x.action_date desc nulls last, x.id desc)
                          from (select ca.id, ca.action_date, ca.recipient_name, ca.description, ca.obligation, ca.source_url
                                from pub.contract_actions ca where ca.agency_id = any (g.ids)
                                order by ca.action_date desc nulls last, ca.id desc limit 5) x), '[]'::jsonb))
    from it
    cross join lateral (select min(a.name) as name, min(a.abbreviation) as abbreviation, array_agg(a.agency_id) as ids
                        from pub.agencies a where agency_slug(a.name) = it.key) g
    where it.kind = 'agency' and g.ids is not null
    union all
    -- search: open matches now, and how many are new since the visitor last reviewed
    select 'search:' || it.key, search_matches(search_parse(it.key), it.since) from it where it.kind = 'search'
  )
  select coalesce(jsonb_object_agg(k, card), '{}'::jsonb) into r from cards;
  return r;
end $$;

-- ── who may call what ───────────────────────────────────────────────────────────────────────
-- Everything needs a signed-in visitor except public_watchlist and watch_cards (public records
-- only), which anonymous visitors use to read a shared list.
revoke execute on function
  app_user_id(), app_require_user(), agency_slug(text), search_key(jsonb), search_parse(text),
  watch_norm(text, text), watch_norm_safe(text, text), competition_of(text, text),
  sol_snapshot(text), watch_snap(text, text), search_sols(jsonb), search_matches(jsonb, timestamptz),
  item_event_rows(text, text, timestamptz, jsonb, int), item_changed(text, text, timestamptz, jsonb),
  item_events(text, text, timestamptz, jsonb, int), account_ensure(text), my_state(), account_touch(text),
  follow(text, text, text, boolean, uuid), list_save(uuid, text, boolean, boolean), item_move(text, text, uuid, uuid),
  item_note(uuid, text, text, text), watch_feed(int), mark_reviewed(uuid, text, text), list_copy(text),
  account_delete(), public_watchlist(text), watch_cards(jsonb)
  from public, anon;
grant execute on function
  app_user_id(), app_require_user(), agency_slug(text), search_key(jsonb), search_parse(text),
  watch_norm(text, text), watch_norm_safe(text, text), competition_of(text, text),
  sol_snapshot(text), watch_snap(text, text), search_sols(jsonb), search_matches(jsonb, timestamptz),
  item_event_rows(text, text, timestamptz, jsonb, int), item_changed(text, text, timestamptz, jsonb),
  item_events(text, text, timestamptz, jsonb, int), account_ensure(text), my_state(), account_touch(text),
  follow(text, text, text, boolean, uuid), list_save(uuid, text, boolean, boolean), item_move(text, text, uuid, uuid),
  item_note(uuid, text, text, text), watch_feed(int), mark_reviewed(uuid, text, text), list_copy(text),
  account_delete(), public_watchlist(text), watch_cards(jsonb)
  to authenticated;
grant execute on function public_watchlist(text), watch_cards(jsonb) to anon;

commit;
