-- 200 — player_rail: compute the stat inline instead of calling player_stat_value().
--
-- APPLIED to production 20 Nov 2026 (as `player_rail_inline_stat_value`).
--
-- player_stat_value() is a SQL function declared with SET search_path, and
-- Postgres never inlines a function that carries a SET clause. player_rail called
-- it once per appearance row (~86k rows on a three-day Plus slate), so every call
-- paid a full function-call round trip per row. Measured on production:
--
--     player_stat_value() over 90,000 rows    2,225 ms
--     the same CASE written inline              158 ms
--
--     player_rail, Plus seat, warm     before    after
--       today (p_days 1, p_day 0)        231 ms    45 ms
--       next 3 days                    2,008 ms   353 ms
--       7 days                         2,245 ms   405 ms
--     first call on a cold cache       16,975 ms 2,521 ms (3 days)
--
-- The 8 s `authenticated` statement timeout was being hit by the three-day board
-- on a cold cache. The stat is resolved ONCE per call into v_kind and the CASE
-- below is player_stat_value()'s body column for column; nothing else changed.
--
-- VERIFIED IDENTICAL before apply: old and new run side by side against
-- production for all 20 stats at 7 days, plus away/home venues and a last-5
-- window — 23 calls, 1,380 rows, EXCEPT ALL empty in both directions.
--
-- player_stat_value() is left in place (nothing else calls it; it is harmless).
-- Signature, grants, SECURITY DEFINER and search_path are unchanged.
--
-- Also: a pg_cron VACUUM (ANALYZE) of player_recent_apps three minutes after each
-- refresh slot. REFRESH ... CONCURRENTLY leaves the visibility map unset, so the
-- covering index's "index-only" scans were fetching the heap (13k heap fetches on
-- one three-day call). It is cheap when the refresh found nothing to change.

CREATE OR REPLACE FUNCTION public.player_rail(p_stat text DEFAULT 'sot1'::text, p_last integer DEFAULT 10, p_days integer DEFAULT 3, p_limit integer DEFAULT 20, p_day integer DEFAULT NULL::integer, p_league uuid DEFAULT NULL::uuid, p_country text DEFAULT NULL::text, p_top5 boolean DEFAULT false, p_venue text DEFAULT NULL::text, p_position text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_min_rate integer DEFAULT 0)
 RETURNS TABLE(match_id uuid, kickoff_at timestamp with time zone, league text, country text, side text, team_name text, opponent text, player_id integer, player_name text, player_position text, apps integer, minutes integer, hits integer, games integer, rate numeric, per90 numeric, run jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
declare
  v_paid  boolean := public.current_tier() <> 'free' or coalesce(auth.role(), '') = 'service_role';
  v_n     integer := greatest(1, least(coalesce(p_last, 10), 20));
  v_line  integer := public.player_stat_line(p_stat);
  v_gk    boolean := p_stat in ('sv2','sv3','sv4');
  v_venue text    := case when p_venue in ('home','away') then p_venue end;
  v_q     text    := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_rate  integer := greatest(0, least(coalesce(p_min_rate, 0), 100));
  -- The stat's column family, resolved ONCE per call. player_stat_value() is a
  -- SQL function with SET search_path, which Postgres will not inline, so
  -- calling it once per appearance cost ~2.2 s per 90k rows (0.16 s inline).
  -- This is the same CASE, keyed on a constant.
  v_kind  text    := case
    when p_stat in ('sot1','sot2') then 'sot'
    when p_stat in ('shot1','shot2') then 'shot'
    when p_stat = 'goal' then 'goal'
    when p_stat = 'ast' then 'ast'
    when p_stat = 'ga' then 'ga'
    when p_stat = 'card' then 'card'
    when p_stat in ('foul1','foul2') then 'foul'
    when p_stat in ('fd1','fd2') then 'fd'
    when p_stat in ('tkl1','tkl2') then 'tkl'
    when p_stat = 'off1' then 'off'
    when p_stat in ('sv2','sv3','sv4') then 'sv'
    when p_stat in ('pas40','pas50') then 'pas'
  end;
  v_min   integer;
  v_ids   integer[];
begin
  if v_line is null then
    raise exception 'unknown stat %', p_stat using errcode = '22023';
  end if;
  v_min := greatest(3, ceil(v_n / 2.0)::integer);

  select array_agg(distinct f.team_api_id) into v_ids
  from public.player_slate_filtered(p_days, v_paid, p_day, p_league, p_country, p_top5, v_venue) f;
  if v_ids is null then return; end if;

  return query
  with fx as materialized (
    select * from public.player_slate_filtered(p_days, v_paid, p_day, p_league, p_country, p_top5, v_venue)
  ),
  team_cut as materialized (
    select u.tid, c.cut
    from unnest(v_ids) u(tid)
    cross join lateral (
      select min(k.ko) as cut, count(*) as n
      from (
        select distinct s.kickoff_at as ko
        from public.player_match_stats s
        where s.team_api_id = u.tid and s.kickoff_at > now() - interval '240 days'
        order by s.kickoff_at desc
        limit 5
      ) k
    ) c
    where c.n >= 5
  ),
  available as materialized (
    select distinct r.player_id as aid, r.cur_team as atid
    from public.player_recent_apps r
    left join team_cut c on c.tid = r.cur_team
    where r.rn = 1 and r.cur_team = any(v_ids)
      and (c.cut is null or r.kickoff_at >= c.cut)
  ),
  app as materialized (
    select r.player_id as pid, r.cur_team as tid, r.cur_name as pname, r.cur_pos as pos,
           r.kickoff_at as ko, r.minutes as mins,
           (case v_kind
              when 'sot'  then case when r.has_shots  then coalesce(r.shots_on, 0) end
              when 'shot' then case when r.has_shots  then coalesce(r.shots_total, 0) end
              when 'goal' then coalesce(r.goals, 0)
              when 'ast'  then coalesce(r.assists, 0)
              when 'ga'   then coalesce(r.goals, 0) + coalesce(r.assists, 0)
              when 'card' then case when r.has_cards  then coalesce(r.yellow, 0) + coalesce(r.red, 0) end
              when 'foul' then case when r.has_fouls  then coalesce(r.fouls_committed, 0) end
              when 'fd'   then case when r.has_fouls  then coalesce(r.fouls_drawn, 0) end
              when 'tkl'  then case when r.has_detail then coalesce(r.tackles, 0) end
              when 'off'  then case when r.has_detail then coalesce(r.offsides, 0) end
              when 'sv'   then case when r.has_detail then coalesce(r.saves, 0) end
              when 'pas'  then case when r.has_detail then coalesce(r.passes_total, 0) end
            end)::numeric as cnt
    from available av
    join public.player_recent_apps r on r.cur_team = av.atid and r.player_id = av.aid
    where (case when v_venue is null then r.rn <= v_n else r.team_side = v_venue and r.rn_side <= v_n end)
      and (not v_gk or r.cur_pos = 'G')
      and (p_position is null or r.cur_pos = p_position)
  ),
  agg as (
    select a.pid, max(a.tid) as tid, max(a.pname) as pname, max(a.pos) as pos,
      count(*)::int                                          as n_apps,
      sum(a.mins)::int                                       as n_mins,
      count(*) filter (where a.cnt >= v_line)::int           as n_hits,
      count(a.cnt)::int                                      as n_games,
      round(sum(a.cnt) * 90.0 / nullif(sum(a.mins) filter (where a.cnt is not null), 0), 2) as n_p90,
      jsonb_agg(a.cnt >= v_line order by a.ko)               as n_run
    from app a
    group by a.pid
  )
  select x.match_id, x.kickoff_at, x.league, x.country, x.side, x.team_name, x.opponent,
         a.pid, a.pname, a.pos, a.n_apps, a.n_mins, a.n_hits, a.n_games,
         round(a.n_hits::numeric / a.n_games, 3), a.n_p90, a.n_run
  from agg a
  join fx x on x.team_api_id = a.tid
  where a.n_games >= v_min and a.n_hits > 0
    and a.n_hits * 100 >= v_rate * a.n_games
    and (v_q is null
         or position(v_q in lower(a.pname)) > 0
         or position(v_q in lower(coalesce(x.team_name, ''))) > 0
         or position(v_q in lower(coalesce(x.opponent, ''))) > 0)
  order by a.n_hits::numeric / a.n_games desc, a.n_hits desc, a.n_p90 desc nulls last, a.n_mins desc
  limit greatest(1, least(coalesce(p_limit, 20), 60));
end;

$function$;

select cron.schedule(
  'vacuum_player_recent_apps',
  '10,25,40,55 * * * *',
  'vacuum (analyze) public.player_recent_apps'
);
