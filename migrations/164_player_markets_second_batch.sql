-- 164 — the second batch of player markets (owner, 19 Oct 2026: "add all").
--
-- The Players sliders launched with eight stats (sot1 sot2 shot1 shot2 goal
-- card foul1 foul2). Every stat below was already stored by 160's ingest; what
-- was missing was a way to rank on it and a per-fixture coverage flag for it.
--
--   ast    Anytime assist        per 90: assists
--   ga     Goal or assist        per 90: goals + assists
--   tkl1   1+ tackle             per 90: tackles
--   tkl2   2+ tackles            per 90: tackles
--   fd1    Fouled 1+ time        per 90: fouls won
--   fd2    Fouled 2+ times       per 90: fouls won
--   off1   Caught offside        per 90: offsides
--   sv3    Keeper 3+ saves       per 90: saves      (goalkeepers only)
--   sv4    Keeper 4+ saves       per 90: saves      (goalkeepers only)
--   pas40  40+ passes            per 90: passes
--   pas50  50+ passes            per 90: passes
--
-- COVERAGE. Tackles, saves, offsides and passes come in the vendor's "full
-- detail" tier, where null means zero (a keeper with no saves, a game with no
-- offsides). A fixture counts toward those stats only when it shows a pass
-- count for somebody: player_stats_fetch_log.has_detail, written by the ingest
-- from this migration on. Fouls drawn rides has_fouls (same family as fouls
-- committed). Assists, like goals, need no flag.
--
-- ONE DEFINITION PER STAT. player_board and player_hit_rail used to carry two
-- copies of an eight-way CASE; both now call player_stat_count() and
-- player_stat_line(), so the dial, the per-90 and the dots cannot disagree.
-- One deliberate change for the old stats: the card per-90 now divides by the
-- minutes of card-covered games only, like every other stat already did.
--
-- Signatures of player_board and player_hit_rail are unchanged, so nothing is
-- dropped and the frontend's calls keep working. The gate is unchanged (162).

alter table public.player_stats_fetch_log
  add column if not exists has_detail boolean not null default false;

-- The count of a stat in one appearance; NULL when that fixture did not report it.
create or replace function public.player_stat_count(
  p_stat text, s public.player_match_stats, g public.player_stats_fetch_log
)
returns numeric
language sql
immutable
set search_path = public, pg_catalog
as $$
  select case
    when p_stat in ('sot1','sot2')   then case when g.has_shots  then coalesce(s.shots_on, 0) end
    when p_stat in ('shot1','shot2') then case when g.has_shots  then coalesce(s.shots_total, 0) end
    when p_stat = 'goal'             then coalesce(s.goals, 0)
    when p_stat = 'ast'              then coalesce(s.assists, 0)
    when p_stat = 'ga'               then coalesce(s.goals, 0) + coalesce(s.assists, 0)
    when p_stat = 'card'             then case when g.has_cards  then coalesce(s.yellow, 0) + coalesce(s.red, 0) end
    when p_stat in ('foul1','foul2') then case when g.has_fouls  then coalesce(s.fouls_committed, 0) end
    when p_stat in ('fd1','fd2')     then case when g.has_fouls  then coalesce(s.fouls_drawn, 0) end
    when p_stat in ('tkl1','tkl2')   then case when g.has_detail then coalesce(s.tackles, 0) end
    when p_stat = 'off1'             then case when g.has_detail then coalesce(s.offsides, 0) end
    when p_stat in ('sv3','sv4')     then case when g.has_detail then coalesce(s.saves, 0) end
    when p_stat in ('pas40','pas50') then case when g.has_detail then coalesce(s.passes_total, 0) end
  end::numeric;
$$;

-- The line a stat must reach to count as a hit. NULL = unknown stat.
create or replace function public.player_stat_line(p_stat text)
returns integer
language sql
immutable
as $$
  select case p_stat
    when 'sot1' then 1 when 'sot2' then 2 when 'shot1' then 1 when 'shot2' then 2
    when 'goal' then 1 when 'ast'  then 1 when 'ga'    then 1 when 'card'  then 1
    when 'foul1' then 1 when 'foul2' then 2 when 'fd1' then 1 when 'fd2'   then 2
    when 'tkl1' then 1 when 'tkl2' then 2 when 'off1'  then 1
    when 'sv3'  then 3 when 'sv4'  then 4 when 'pas40' then 40 when 'pas50' then 50
  end;
$$;

revoke all on function public.player_stat_count(text, public.player_match_stats, public.player_stats_fetch_log) from public, anon, authenticated;
revoke all on function public.player_stat_line(text) from public, anon, authenticated;
grant execute on function public.player_stat_count(text, public.player_match_stats, public.player_stats_fetch_log) to service_role;
grant execute on function public.player_stat_line(text) to service_role;

create or replace function public.player_board(
  p_stat  text    default 'sot1',
  p_last  integer default 10,
  p_days  integer default 3,
  p_limit integer default 100
)
returns table (
  match_id uuid, kickoff_at timestamptz, league text, country text, side text,
  team_name text, opponent text,
  player_id integer, player_name text, player_position text,
  apps integer, minutes integer, hits integer, games integer, rate numeric, per90 numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
#variable_conflict use_column
declare
  v_paid boolean := public.current_tier() <> 'free';
  v_n    integer := greatest(1, least(coalesce(p_last, 10), 20));
  v_line integer := public.player_stat_line(p_stat);
  v_gk   boolean := p_stat in ('sv3','sv4');
  v_min  integer;
  v_ids  integer[];
begin
  if v_line is null then
    raise exception 'unknown stat %', p_stat using errcode = '22023';
  end if;
  v_min := greatest(3, ceil(v_n / 2.0)::integer);

  select array_agg(distinct fx.team_api_id) into v_ids
  from public.player_board_fixtures(p_days, v_paid) fx;
  if v_ids is null then return; end if;

  return query
  with cand as (
    select distinct s.player_id as pid
    from public.player_match_stats s
    where s.team_api_id = any(v_ids)
      and s.minutes > 0
      and s.kickoff_at > now() - interval '240 days'
  ),
  squad as (
    select l.*
    from cand c
    cross join lateral (
      select s.player_id as pid, s.player_name as pname, s.team_api_id as tid, s.player_position as pos
      from public.player_match_stats s
      where s.player_id = c.pid and s.minutes > 0
      order by s.kickoff_at desc
      limit 1
    ) l
    where l.tid = any(v_ids)
      and (not v_gk or l.pos = 'G')
  ),
  app as (
    select q.pid, s.minutes as mins, public.player_stat_count(p_stat, s, g) as cnt
    from squad q
    cross join lateral (
      select s.*
      from public.player_match_stats s
      where s.player_id = q.pid and s.minutes > 0
      order by s.kickoff_at desc
      limit v_n
    ) s
    join public.player_stats_fetch_log g on g.fixture_id = s.fixture_id
  ),
  agg as (
    select a.pid,
      count(*)::int                                          as n_apps,
      sum(a.mins)::int                                       as n_mins,
      count(*) filter (where a.cnt >= v_line)::int           as n_hits,
      count(a.cnt)::int                                      as n_games,
      round(sum(a.cnt) * 90.0 / nullif(sum(a.mins) filter (where a.cnt is not null), 0), 2) as n_p90
    from app a
    group by a.pid
  )
  select x.match_id, x.kickoff_at, x.league, x.country, x.side, x.team_name, x.opponent,
         q.pid, q.pname, q.pos, a.n_apps, a.n_mins, a.n_hits, a.n_games,
         round(a.n_hits::numeric / a.n_games, 3), a.n_p90
  from agg a
  join squad q on q.pid = a.pid
  join public.player_board_fixtures(p_days, v_paid) x on x.team_api_id = q.tid
  where a.n_games >= v_min and a.n_hits > 0
  order by a.n_hits::numeric / a.n_games desc, a.n_hits desc, a.n_p90 desc nulls last, a.n_mins desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

create or replace function public.player_hit_rail(
  p_stat  text    default 'sot1',
  p_last  integer default 10,
  p_days  integer default 3,
  p_limit integer default 20
)
returns table (
  match_id uuid, kickoff_at timestamptz, league text, country text, side text,
  team_name text, opponent text,
  player_id integer, player_name text, player_position text,
  apps integer, minutes integer, hits integer, games integer, rate numeric, per90 numeric,
  run jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_n    integer := greatest(1, least(coalesce(p_last, 10), 20));
  v_line integer := public.player_stat_line(p_stat);
begin
  return query
  with ranked as (
    select * from public.player_board(p_stat, v_n, p_days, greatest(1, least(coalesce(p_limit, 20), 60)))
  )
  select r.match_id, r.kickoff_at, r.league, r.country, r.side, r.team_name, r.opponent,
         r.player_id, r.player_name, r.player_position, r.apps, r.minutes, r.hits, r.games, r.rate, r.per90,
         (
           select coalesce(jsonb_agg(q.h order by q.ko), '[]'::jsonb)
           from (
             select s.kickoff_at as ko, public.player_stat_count(p_stat, s, g) >= v_line as h
             from public.player_match_stats s
             join public.player_stats_fetch_log g on g.fixture_id = s.fixture_id
             where s.player_id = r.player_id and s.minutes > 0
             order by s.kickoff_at desc
             limit v_n
           ) q
         )
  from ranked r;
end;
$$;

revoke all on function public.player_board(text, integer, integer, integer) from public;
grant execute on function public.player_board(text, integer, integer, integer) to anon, authenticated, service_role;
revoke all on function public.player_hit_rail(text, integer, integer, integer) from public;
grant execute on function public.player_hit_rail(text, integer, integer, integer) to anon, authenticated, service_role;

comment on function public.player_board(text, integer, integer, integer) is
  'Top players in the coming fixtures on one stat: sot1 sot2 shot1 shot2 goal ast ga card foul1 foul2 fd1 fd2 tkl1 tkl2 off1 sv3 sv4 (keepers) pas40 pas50. Paid: every fixture; free/anon: preview fixtures only. See migrations 162, 164.';
