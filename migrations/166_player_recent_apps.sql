-- 166 — player_rail reads a precomputed window (19 Oct 2026).
--
-- WHY. With the backfill at ~7k fixtures, a paid reader's unfiltered Last 10
-- slider took 11.8s against the authenticated role's 8s statement_timeout, so
-- every slider errored and the Players tab drew nothing. The work was the same
-- on every view: for every player on ~170 clubs, find his current club, then
-- his last N appearances, then the coverage flags. None of it changes between
-- backfill runs.
--
-- WHAT. player_recent_apps: each player's last 20 appearances (and last 20 at
-- each ground, for the venue cut), with his current club, name and position
-- from his latest appearance (240-day rule, unchanged) and the fixture's
-- coverage flags. Refreshed by refresh_player_recent(), which the backfill
-- calls at the end of every run. player_rail keeps its signature and gate;
-- only the source changes.

create materialized view if not exists public.player_recent_apps as
with cur as (
  select distinct on (s.player_id)
         s.player_id, s.team_api_id as cur_team, s.player_name as cur_name, s.player_position as cur_pos
  from public.player_match_stats s
  where s.minutes > 0 and s.kickoff_at > now() - interval '240 days'
  order by s.player_id, s.kickoff_at desc
),
ranked as (
  select s.player_id, s.fixture_id, s.kickoff_at, s.team_side, s.minutes,
         s.shots_total, s.shots_on, s.goals, s.assists, s.yellow, s.red,
         s.fouls_committed, s.fouls_drawn, s.tackles, s.offsides, s.saves, s.passes_total,
         g.has_shots, g.has_cards, g.has_fouls, g.has_detail,
         row_number() over (partition by s.player_id order by s.kickoff_at desc)                as rn,
         row_number() over (partition by s.player_id, s.team_side order by s.kickoff_at desc)   as rn_side
  from public.player_match_stats s
  join cur c on c.player_id = s.player_id
  join public.player_stats_fetch_log g on g.fixture_id = s.fixture_id
  where s.minutes > 0
)
select r.*, c.cur_team, c.cur_name, c.cur_pos
from ranked r join cur c on c.player_id = r.player_id
where r.rn <= 20 or r.rn_side <= 20;

create unique index if not exists player_recent_apps_pk on public.player_recent_apps (player_id, fixture_id);
create index if not exists player_recent_apps_team on public.player_recent_apps (cur_team, player_id, rn);

revoke all on public.player_recent_apps from public, anon, authenticated;
grant select on public.player_recent_apps to service_role;

create or replace function public.refresh_player_recent()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  refresh materialized view concurrently public.player_recent_apps;
end;
$$;
revoke all on function public.refresh_player_recent() from public, anon, authenticated;
grant execute on function public.refresh_player_recent() to service_role;

-- Plain column arguments so the planner inlines it; a composite argument made
-- it build the whole row per call, ~700ms over a full slate.
create or replace function public.player_stat_value(
  p_stat text, has_shots boolean, has_cards boolean, has_fouls boolean, has_detail boolean,
  shots_on smallint, shots_total smallint, goals smallint, assists smallint, yellow smallint, red smallint,
  fouls_committed smallint, fouls_drawn smallint, tackles smallint, offsides smallint, saves smallint, passes_total smallint
)
returns numeric
language sql
immutable
as $$
  select case
    when p_stat in ('sot1','sot2')   then case when has_shots  then coalesce(shots_on, 0) end
    when p_stat in ('shot1','shot2') then case when has_shots  then coalesce(shots_total, 0) end
    when p_stat = 'goal'             then coalesce(goals, 0)
    when p_stat = 'ast'              then coalesce(assists, 0)
    when p_stat = 'ga'               then coalesce(goals, 0) + coalesce(assists, 0)
    when p_stat = 'card'             then case when has_cards  then coalesce(yellow, 0) + coalesce(red, 0) end
    when p_stat in ('foul1','foul2') then case when has_fouls  then coalesce(fouls_committed, 0) end
    when p_stat in ('fd1','fd2')     then case when has_fouls  then coalesce(fouls_drawn, 0) end
    when p_stat in ('tkl1','tkl2')   then case when has_detail then coalesce(tackles, 0) end
    when p_stat = 'off1'             then case when has_detail then coalesce(offsides, 0) end
    when p_stat in ('sv3','sv4')     then case when has_detail then coalesce(saves, 0) end
    when p_stat in ('pas40','pas50') then case when has_detail then coalesce(passes_total, 0) end
  end::numeric;
$$;
revoke all on function public.player_stat_value(text, boolean, boolean, boolean, boolean, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint) from public, anon, authenticated;
grant execute on function public.player_stat_value(text, boolean, boolean, boolean, boolean, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint, smallint) to service_role;

create or replace function public.player_rail(
  p_stat     text    default 'sot1',
  p_last     integer default 10,
  p_days     integer default 3,
  p_limit    integer default 20,
  p_day      integer default null,
  p_league   uuid    default null,
  p_country  text    default null,
  p_top5     boolean default false,
  p_venue    text    default null,
  p_position text    default null,
  p_query    text    default null,
  p_min_rate integer default 0
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
#variable_conflict use_column
declare
  v_paid  boolean := public.current_tier() <> 'free';
  v_n     integer := greatest(1, least(coalesce(p_last, 10), 20));
  v_line  integer := public.player_stat_line(p_stat);
  v_gk    boolean := p_stat in ('sv3','sv4');
  v_venue text    := case when p_venue in ('home','away') then p_venue end;
  v_q     text    := nullif(lower(btrim(coalesce(p_query, ''))), '');
  v_rate  integer := greatest(0, least(coalesce(p_min_rate, 0), 100));
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
  -- MATERIALIZED: inlined, the slate was re-planned inside the join and ran
  -- once per player (3.5s); read once, the whole rail is milliseconds.
  with fx as materialized (
    select * from public.player_slate_filtered(p_days, v_paid, p_day, p_league, p_country, p_top5, v_venue)
  ),
  app as materialized (
    select r.player_id as pid, r.cur_team as tid, r.cur_name as pname, r.cur_pos as pos,
           r.kickoff_at as ko, r.minutes as mins,
           public.player_stat_value(p_stat, r.has_shots, r.has_cards, r.has_fouls, r.has_detail,
             r.shots_on, r.shots_total, r.goals, r.assists, r.yellow, r.red, r.fouls_committed,
             r.fouls_drawn, r.tackles, r.offsides, r.saves, r.passes_total) as cnt
    from public.player_recent_apps r
    where r.cur_team = any(v_ids)
      and (case when v_venue is null then r.rn <= v_n else r.team_side = v_venue and r.rn_side <= v_n end)
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
$$;
