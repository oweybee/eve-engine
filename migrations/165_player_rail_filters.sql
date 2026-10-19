-- 165 — the Players tab gets the Teams board's filters (owner, 19 Oct 2026:
-- "replicate the teams filters").
--
-- Each slider ranks the top N players on the slate, so a filter cannot be a
-- cut of what the browser already holds: "La Liga" over the top twenty of
-- every league is the two or three La Liga players who happened to be in
-- them. The filters are therefore ARGUMENTS of the ranking:
--
--   p_day       London day offset of the kickoff (0 today, 1 tomorrow, ...)
--   p_league    a league uuid           p_country  a league's country
--   p_top5      the five big leagues (same list as lib/hitFilters TOP_FIVE)
--   p_venue     'home' / 'away': players whose side is at that ground in the
--               coming fixture, counted on their games AT that ground only
--               (the Teams board's venue rule: it changes what is counted)
--   p_position  G / D / M / F
--   p_query     a player, his club or the opponent, case-insensitive
--   p_min_rate  a hit-rate floor, whole percent
--
-- player_slate_options() hands the filter bar its days, leagues and countries,
-- under the same gate, so a free reader is offered only what he can open.
-- Gate unchanged (161/162): paid = the slate, free/anon = preview fixtures.
-- player_board / player_hit_rail stay as they are for any older caller.

do $$ begin
  create type public.player_slate_row as (
    match_id uuid, kickoff_at timestamptz, day_offset integer,
    league_id uuid, league text, country text,
    team_api_id integer, side text, team_name text, opponent text
  );
exception when duplicate_object then null; end $$;

create or replace function public.player_slate(p_days integer, p_paid boolean)
returns setof public.player_slate_row
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.id, m.kickoff_at,
         ((m.kickoff_at at time zone 'Europe/London')::date - (now() at time zone 'Europe/London')::date)::int,
         m.league_id, l.name, l.country, x.api, x.side, x.me, x.them
  from public.matches m
  join public.teams th on th.id = m.home_team_id
  join public.teams ta on ta.id = m.away_team_id
  left join public.leagues l on l.id = m.league_id
  cross join lateral (values
    (nullif(th.external_id, '')::integer, 'home', th.name, ta.name),
    (nullif(ta.external_id, '')::integer, 'away', ta.name, th.name)
  ) as x(api, side, me, them)
  where m.kickoff_at > now()
    and m.kickoff_at < now() + make_interval(days => greatest(1, least(coalesce(p_days, 3), 7)))
    and m.goals_home is null
    and x.api is not null
    and (p_paid or m.external_id in (select public.preview_fixture_external_ids()));
$$;
revoke all on function public.player_slate(integer, boolean) from public, anon, authenticated;
grant execute on function public.player_slate(integer, boolean) to service_role;

-- What the filter bar can offer: one row per fixture on the (gated) slate.
create or replace function public.player_slate_options(p_days integer default 3)
returns table (match_id uuid, kickoff_at timestamptz, day_offset integer, league_id uuid, league text, country text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select distinct s.match_id, s.kickoff_at, s.day_offset, s.league_id, s.league, s.country
  from public.player_slate(p_days, public.current_tier() <> 'free') s
  order by s.kickoff_at;
$$;
revoke all on function public.player_slate_options(integer) from public;
grant execute on function public.player_slate_options(integer) to anon, authenticated, service_role;

-- The slate under the fixture-side filters. Internal: the caller passes p_paid.
create or replace function public.player_slate_filtered(
  p_days integer, p_paid boolean, p_day integer, p_league uuid, p_country text,
  p_top5 boolean, p_venue text
)
returns setof public.player_slate_row
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select x.*
  from public.player_slate(p_days, p_paid) x
  where (p_day is null or x.day_offset = p_day)
    and (p_league is null or x.league_id = p_league)
    and (p_country is null or x.country = p_country)
    and (not coalesce(p_top5, false) or (x.country, x.league) in (
          ('England','Premier League'), ('Spain','La Liga'), ('Italy','Serie A'),
          ('Germany','Bundesliga'), ('France','Ligue 1')))
    and (p_venue is null or x.side = p_venue);
$$;
revoke all on function public.player_slate_filtered(integer, boolean, integer, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.player_slate_filtered(integer, boolean, integer, uuid, text, boolean, text) to service_role;

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
      and (p_position is null or l.pos = p_position)
  ),
  app as (
    select q.pid, s.kickoff_at as ko, s.minutes as mins, public.player_stat_count(p_stat, s, g) as cnt
    from squad q
    cross join lateral (
      select s.*
      from public.player_match_stats s
      where s.player_id = q.pid and s.minutes > 0
        and (v_venue is null or s.team_side = v_venue)
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
      round(sum(a.cnt) * 90.0 / nullif(sum(a.mins) filter (where a.cnt is not null), 0), 2) as n_p90,
      jsonb_agg(a.cnt >= v_line order by a.ko)               as n_run
    from app a
    group by a.pid
  )
  select x.match_id, x.kickoff_at, x.league, x.country, x.side, x.team_name, x.opponent,
         q.pid, q.pname, q.pos, a.n_apps, a.n_mins, a.n_hits, a.n_games,
         round(a.n_hits::numeric / a.n_games, 3), a.n_p90, a.n_run
  from agg a
  join squad q on q.pid = a.pid
  join public.player_slate_filtered(p_days, v_paid, p_day, p_league, p_country, p_top5, v_venue) x
    on x.team_api_id = q.tid
  where a.n_games >= v_min and a.n_hits > 0
    and a.n_hits * 100 >= v_rate * a.n_games
    and (v_q is null
         or position(v_q in lower(q.pname)) > 0
         or position(v_q in lower(coalesce(x.team_name, ''))) > 0
         or position(v_q in lower(coalesce(x.opponent, ''))) > 0)
  order by a.n_hits::numeric / a.n_games desc, a.n_hits desc, a.n_p90 desc nulls last, a.n_mins desc
  limit greatest(1, least(coalesce(p_limit, 20), 60));
end;
$$;

revoke all on function public.player_rail(text, integer, integer, integer, integer, uuid, text, boolean, text, text, text, integer) from public;
grant execute on function public.player_rail(text, integer, integer, integer, integer, uuid, text, boolean, text, text, text, integer) to anon, authenticated, service_role;

comment on function public.player_rail(text, integer, integer, integer, integer, uuid, text, boolean, text, text, text, integer) is
  'One Players slider with the Teams board''s filters (day, league, country, top 5, venue, position, search, rate floor). Gate as player_board: paid = the slate, free/anon = preview fixtures. See migration 165.';
