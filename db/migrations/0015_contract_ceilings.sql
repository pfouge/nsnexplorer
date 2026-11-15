-- 0015: contract ceilings are not money spent (2026-11-15).
--
-- A DIBBS award that is the BASE award of an indefinite-delivery contract (9th character of the award number
-- D, G or A, and no delivery order) carries the contract's maximum value as its total. When such an award
-- matched a solicitation it also became a pub.price_points row whose "unit price" is that ceiling divided by
-- the solicitation quantity. Those rows stay in the table (they are evidence of a win and the supplier pages
-- list them), but no total, price statistic, count or rank may use them. The rule lives in
-- web/src/lib/contract-ceiling.ts (CEILING_PRICE_POINT_SQL and CONTRACT_CEILING_SQL); the text below is those fragments written
-- out for the aliases used in each function, and web/src/lib/contract-ceiling.test.ts fails when it drifts.
--
-- Redefines three functions, bodies otherwise identical to their originals:
--   pub.refresh_supplier_stats()  (0011)  per-supplier totals and leaderboard ranks
--   item_event_rows(...)          (0009)  the watchlist "new award" and "contract action" events
--   watch_cards(jsonb)            (0009)  the watchlist cards: award counts, last prices, supplier months, agency awards and contract actions
-- CREATE OR REPLACE keeps each function's grants. This migration changes no table data: pub.supplier_stats is
-- rebuilt by `node db/refresh-supplier-stats.mjs` (deploy.yml and ingest-daily.yml run it right after migrating).
--
-- db/migrate.mjs wraps this file in one transaction (no begin/commit here).

-- pub.refresh_supplier_stats(): see 0011 for the rules. Change: price points that are contract ceilings are ignored,
-- so a supplier whose only price points are ceilings gets no stats row until it has a purchase.
CREATE OR REPLACE FUNCTION pub.refresh_supplier_stats() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  TRUNCATE pub.supplier_stats;

  INSERT INTO pub.supplier_stats (
    cage, awards_all, dollars_all, awards_12m, dollars_12m, awards_prior_12m, dollars_prior_12m,
    nsns, fscs, agencies, first_award, last_award,
    rank_dollars_12m, rank_dollars_all, rank_wins_12m, rank_wins_all, rank_nsns, rank_fscs, rank_rising,
    rising_delta, refreshed_at)
  WITH agg AS (
    SELECT pp.cage,
           count(*)::int                                              AS awards_all,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity)), 0) AS dollars_all,
           (count(*) FILTER (WHERE pp.awarded_on > CURRENT_DATE - 365))::int AS awards_12m,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity))
                    FILTER (WHERE pp.awarded_on > CURRENT_DATE - 365), 0) AS dollars_12m,
           (count(*) FILTER (WHERE pp.awarded_on > CURRENT_DATE - 730
                               AND pp.awarded_on <= CURRENT_DATE - 365))::int AS awards_prior_12m,
           COALESCE(sum(COALESCE(pp.total_value, pp.unit_price * pp.quantity))
                    FILTER (WHERE pp.awarded_on > CURRENT_DATE - 730
                              AND pp.awarded_on <= CURRENT_DATE - 365), 0) AS dollars_prior_12m,
           count(DISTINCT pp.nsn)::int                                AS nsns,
           count(DISTINCT n.fsc)::int                                 AS fscs,
           count(DISTINCT pp.agency_id)::int                          AS agencies,
           min(pp.awarded_on)                                         AS first_award,
           max(pp.awarded_on)                                         AS last_award
    FROM pub.price_points pp
    JOIN pub.nsns n ON n.nsn = pp.nsn
    WHERE pp.cage IS NOT NULL
      AND NOT COALESCE(pp.source = 'dibbs_award' AND upper(substr(pp.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in pp.award_ref) = 0, false)
    GROUP BY pp.cage
  ), delta AS (
    SELECT agg.*, (dollars_12m - dollars_prior_12m) AS rising_delta FROM agg
  )
  SELECT d.cage, d.awards_all, d.dollars_all, d.awards_12m, d.dollars_12m,
         d.awards_prior_12m, d.dollars_prior_12m, d.nsns, d.fscs, d.agencies,
         d.first_award, d.last_award,
         CASE WHEN d.dollars_12m > 0 THEN row_number() OVER (ORDER BY d.dollars_12m DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.dollars_all > 0 THEN row_number() OVER (ORDER BY d.dollars_all DESC, d.cage COLLATE "C" ASC) END,
         CASE WHEN d.awards_12m  > 0 THEN row_number() OVER (ORDER BY d.awards_12m  DESC, d.cage ASC) END,
         CASE WHEN d.awards_all  > 0 THEN row_number() OVER (ORDER BY d.awards_all  DESC, d.cage ASC) END,
         CASE WHEN d.nsns        > 0 THEN row_number() OVER (ORDER BY d.nsns        DESC, d.cage ASC) END,
         CASE WHEN d.fscs        > 0 THEN row_number() OVER (ORDER BY d.fscs        DESC, d.cage ASC) END,
         CASE WHEN d.dollars_12m >= 10000 AND d.awards_12m >= 3
              THEN row_number() OVER (
                     PARTITION BY (d.dollars_12m >= 10000 AND d.awards_12m >= 3)
                     ORDER BY d.rising_delta DESC, d.cage COLLATE "C" ASC) END,
         d.rising_delta, now()
  FROM delta d;
  -- A metric of 0 sorts last, so ranking every row and blanking the zeros leaves 1..k on the rest.
  -- rank_rising ranks inside its own partition (the qualifying suppliers), so non-qualifying
  -- suppliers never take a position.
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

-- item_event_rows: change: price points and contract actions that are contract ceilings raise no event.
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
      from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.suppliers su on su.cage = p.cage
      where p.nsn = p_key::bpchar and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'supplier' then
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'item', n.item_name, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price,
                                'quantity', p.quantity, 'sol', p.sol_number, 'url', p.source_url)
      from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.nsns n on n.nsn = p.nsn
      where p.cage = p_key::bpchar and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;
    return query
      select 'contract_action'::text, ca.ingested_at,
             jsonb_build_object('action_date', ca.action_date, 'obligation', ca.obligation, 'description', ca.description,
                                'agency', ag.name, 'piid', ca.piid, 'url', ca.source_url)
      from (select q.* from pub.contract_actions q where not COALESCE(q.award_uid LIKE 'DIBBS-%' AND upper(substr(q.piid, 9, 1)) IN ('D', 'G', 'A') AND NULLIF(btrim(q.raw ->> 'deliveryOrder'), '') IS NULL, false)) ca left join pub.agencies ag on ag.agency_id = ca.agency_id
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
      join (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p on p.nsn = n.nsn
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
      from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.suppliers su on su.cage = p.cage
      where p.sol_number = p_key and p.ingested_at > p_since
      order by p.ingested_at desc limit p_limit;

  elsif p_kind = 'agency' then
    return query
      select 'contract_action'::text, ca.ingested_at,
             jsonb_build_object('action_date', ca.action_date, 'obligation', ca.obligation, 'description', ca.description,
                                'recipient', ca.recipient_name, 'piid', ca.piid, 'url', ca.source_url)
      from pub.agencies a
      join (select q.* from pub.contract_actions q where not COALESCE(q.award_uid LIKE 'DIBBS-%' AND upper(substr(q.piid, 9, 1)) IN ('D', 'G', 'A') AND NULLIF(btrim(q.raw ->> 'deliveryOrder'), '') IS NULL, false)) ca on ca.agency_id = a.agency_id
      where agency_slug(a.name) = p_key and ca.ingested_at > p_since
      order by ca.ingested_at desc limit p_limit;
    return query
      select 'award'::text, p.ingested_at,
             jsonb_build_object('nsn', p.nsn::text, 'item', n.item_name, 'awarded_on', p.awarded_on, 'unit_price', p.unit_price,
                                'quantity', p.quantity, 'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
      from pub.agencies a
      join (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p on p.agency_id = a.agency_id
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

-- watch_cards: change: price points and contract actions that are contract ceilings are not counted, priced or summed.
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
      'award_count', (select count(*) from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p where p.nsn = n.nsn),
      'prices', coalesce((select jsonb_agg(jsonb_build_array(x.awarded_on, x.unit_price) order by x.awarded_on, x.id)
                          from (select p.id, p.awarded_on, p.unit_price from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p where p.nsn = n.nsn
                                order by p.awarded_on desc, p.id desc limit 12) x), '[]'::jsonb),
      'latest', (select jsonb_build_object('date', p.awarded_on, 'unit_price', p.unit_price, 'quantity', p.quantity,
                                           'cage', p.cage::text, 'supplier', su.name, 'url', p.source_url)
                 from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.suppliers su on su.cage = p.cage
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
      'award_count', (select count(*) from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p where p.cage = su.cage),
      'months', (select jsonb_agg(jsonb_build_array(to_char(m.mo, 'YYYY-MM'), coalesce(c.n, 0), coalesce(c.v, 0)) order by m.mo)
                 from generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date),
                                      interval '1 month') m(mo)
                 left join (select date_trunc('month', p.awarded_on) as mo, count(*) as n,
                                   sum(coalesce(p.total_value, p.unit_price * p.quantity)) as v
                            from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p
                            where p.cage = su.cage and p.awarded_on >= date_trunc('month', current_date) - interval '11 months'
                            group by 1) c on c.mo = m.mo),
      'wins', coalesce((select jsonb_agg(jsonb_build_object('date', x.awarded_on, 'nsn', x.nsn::text, 'item', x.item_name,
                                                            'unit_price', x.unit_price, 'quantity', x.quantity, 'url', x.source_url)
                                         order by x.awarded_on desc, x.id desc)
                        from (select p.id, p.awarded_on, p.nsn, n.item_name, p.unit_price, p.quantity, p.source_url
                              from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.nsns n on n.nsn = p.nsn
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
                from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p left join pub.suppliers su on su.cage = p.cage
                where p.sol_number = s.sol_number order by p.awarded_on desc, p.id desc limit 1))
    from it join pub.solicitations s on s.sol_number = it.key and it.kind = 'solicitation'
    left join pub.nsns n on n.nsn = s.nsn
    union all
    -- agency: name, contract actions and awards in the last 90 days (count, value), latest 5 actions
    select 'agency:' || it.key, jsonb_build_object(
      'name', g.name, 'abbreviation', g.abbreviation,
      'actions_90d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(ca.obligation), 0))
                      from (select q.* from pub.contract_actions q where not COALESCE(q.award_uid LIKE 'DIBBS-%' AND upper(substr(q.piid, 9, 1)) IN ('D', 'G', 'A') AND NULLIF(btrim(q.raw ->> 'deliveryOrder'), '') IS NULL, false)) ca where ca.agency_id = any (g.ids) and ca.action_date >= current_date - 90),
      'awards_90d', (select jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(p.total_value, p.unit_price * p.quantity)), 0))
                     from (select q.* from pub.price_points q where not COALESCE(q.source = 'dibbs_award' AND upper(substr(q.award_ref, 9, 1)) IN ('D', 'G', 'A') AND position('-' in q.award_ref) = 0, false)) p where p.agency_id = any (g.ids) and p.awarded_on >= current_date - 90),
      'latest', coalesce((select jsonb_agg(jsonb_build_object('date', x.action_date, 'recipient', x.recipient_name,
                                                              'description', x.description, 'obligation', x.obligation, 'url', x.source_url)
                                           order by x.action_date desc nulls last, x.id desc)
                          from (select ca.id, ca.action_date, ca.recipient_name, ca.description, ca.obligation, ca.source_url
                                from (select q.* from pub.contract_actions q where not COALESCE(q.award_uid LIKE 'DIBBS-%' AND upper(substr(q.piid, 9, 1)) IN ('D', 'G', 'A') AND NULLIF(btrim(q.raw ->> 'deliveryOrder'), '') IS NULL, false)) ca where ca.agency_id = any (g.ids)
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
