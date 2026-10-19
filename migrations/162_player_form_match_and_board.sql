-- 162 — the two reads the frontend actually makes: one match, and the board.
--
-- 160/161 shipped player_form(team_ids), which is the right primitive and the
-- wrong door for both surfaces the owner asked for on 19 Oct 2026:
--   * the match page knows a match uuid, not two API-Football team ids;
--   * the /hit-rate Players tab ranks EVERY player in the coming fixtures, and
--     shipping fifteen thousand rows to a browser to sort them there would hit
--     PostgREST's row cap long before it hit the reader.
-- So this adds player_form_match(match) and player_board(stat), and makes the
-- core cheaper so the board can afford to call it across a whole slate.
--
-- THE CORE NO LONGER SCANS THE TABLE. 160's `latest` CTE took DISTINCT ON over
-- every appearance in 240 days to find each player's current club, then
-- filtered to the asked-for teams. It now starts from the asked-for teams
-- (team index), and only then checks each candidate's most recent appearance
-- (player index). Same answer, a few hundred rows read instead of all of them.
-- The four-team cap moves from the core to the public player_form(), so the
-- board can pass a slate.
--
-- GATING IS 161's RULE, UNCHANGED: paid tiers see everything; free and anon see
-- the preview fixture(s) only. player_form_match raises 42501 like player_form;
-- player_board FILTERS to the preview fixtures for a free reader instead,
-- because a board with two open rows and a lock is the shape every other board
-- on the site has.

create or replace function public.player_form_unchecked(
  p_team_api_ids integer[],
  p_last         integer default 10,
  p_league_id    uuid    default null
)
returns table (
  player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer, goals integer, assists integer,
  games_scored integer, shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric, card_games integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with args as (
    select greatest(1, least(coalesce(p_last, 10), 50)) as n
  ),
  candidates as (
    select distinct s.player_id
    from public.player_match_stats s
    where s.team_api_id = any(p_team_api_ids)
      and s.minutes > 0
      and s.kickoff_at > now() - interval '240 days'
  ),
  squad as (
    select l.*
    from candidates c
    cross join lateral (
      select s.player_id, s.player_name, s.team_api_id, s.team_name, s.player_position
      from public.player_match_stats s
      where s.player_id = c.player_id and s.minutes > 0
      order by s.kickoff_at desc
      limit 1
    ) l
    where l.team_api_id = any(p_team_api_ids)
  ),
  apps as (
    select s.*, g.has_shots, g.has_cards, g.has_fouls, a.n
    from squad q
    cross join args a
    cross join lateral (
      select s.*
      from public.player_match_stats s
      where s.player_id = q.player_id and s.minutes > 0
        and (p_league_id is null or s.league_id = p_league_id)
      order by s.kickoff_at desc
      limit a.n
    ) s
    join public.player_stats_fetch_log g on g.fixture_id = s.fixture_id
  ),
  agg as (
    select a.player_id,
      max(a.kickoff_at)                                                         as last_kickoff,
      count(*)::int                                                             as apps,
      count(*) filter (where not coalesce(a.is_sub, false))::int                as starts,
      sum(a.minutes)::int                                                       as minutes,
      sum(coalesce(a.goals, 0))::int                                            as goals,
      sum(coalesce(a.assists, 0))::int                                          as assists,
      count(*) filter (where a.goals > 0)::int                                  as games_scored,
      count(*) filter (where a.has_shots)::int                                  as shot_games,
      coalesce(sum(a.minutes) filter (where a.has_shots), 0)::int               as shot_minutes,
      coalesce(sum(coalesce(a.shots_total, 0)) filter (where a.has_shots), 0)::int as shots,
      coalesce(sum(coalesce(a.shots_on, 0))    filter (where a.has_shots), 0)::int as sot,
      count(*) filter (where a.has_shots and a.shots_total >= 1)::int           as games_1plus_shot,
      count(*) filter (where a.has_shots and a.shots_total >= 2)::int           as games_2plus_shots,
      count(*) filter (where a.has_shots and a.shots_on >= 1)::int              as games_1plus_sot,
      count(*) filter (where a.has_shots and a.shots_on >= 2)::int              as games_2plus_sot,
      count(*) filter (where a.has_cards)::int                                  as card_games,
      coalesce(sum(coalesce(a.yellow, 0)) filter (where a.has_cards), 0)::int   as yellows,
      coalesce(sum(coalesce(a.red, 0))    filter (where a.has_cards), 0)::int   as reds,
      count(*) filter (where a.has_cards and (a.yellow > 0 or a.red > 0))::int  as games_carded,
      count(*) filter (where a.has_fouls)::int                                  as foul_games,
      coalesce(sum(a.minutes) filter (where a.has_fouls), 0)::int               as foul_minutes,
      coalesce(sum(coalesce(a.fouls_committed, 0)) filter (where a.has_fouls), 0)::int as fouls_committed,
      coalesce(sum(coalesce(a.fouls_drawn, 0))     filter (where a.has_fouls), 0)::int as fouls_drawn,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 1)::int       as games_1plus_foul,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 2)::int       as games_2plus_fouls
    from apps a
    group by a.player_id
  )
  select q.player_id, q.player_name, q.team_api_id, q.team_name, q.player_position,
         g.last_kickoff, g.apps, g.starts, g.minutes, g.goals, g.assists, g.games_scored,
         g.shot_games, g.shot_minutes, g.shots, g.sot,
         g.games_1plus_shot, g.games_2plus_shots, g.games_1plus_sot, g.games_2plus_sot,
         round(g.shots * 90.0 / nullif(g.shot_minutes, 0), 2),
         round(g.sot   * 90.0 / nullif(g.shot_minutes, 0), 2),
         g.card_games, g.yellows, g.reds, g.games_carded,
         g.foul_games, g.foul_minutes, g.fouls_committed, g.fouls_drawn,
         g.games_1plus_foul, g.games_2plus_fouls,
         round(g.fouls_committed * 90.0 / nullif(g.foul_minutes, 0), 2)
  from agg g join squad q on q.player_id = g.player_id
  order by q.team_api_id, g.sot desc, g.shots desc, g.minutes desc;
$$;

-- The public team door keeps its four-team cap.
create or replace function public.player_form(
  p_team_api_ids integer[],
  p_last         integer default 10,
  p_league_id    uuid    default null
)
returns table (
  player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer, goals integer, assists integer,
  games_scored integer, shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric, card_games integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
begin
  if not public.player_form_allowed(p_team_api_ids[1:4]) then
    raise exception 'player hit rates are a paid feature'
      using errcode = '42501', hint = 'upgrade';
  end if;
  return query select * from public.player_form_unchecked(p_team_api_ids[1:4], p_last, p_league_id);
end;
$$;

-- ── One match ────────────────────────────────────────────────────────────
-- p_league_only: count only games in this fixture's competition (the team
-- board's "league games only" rule); default false = all competitions.
create or replace function public.player_form_match(
  p_match_id    uuid,
  p_last        integer default 10,
  p_league_only boolean default false
)
returns table (
  side text,
  player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer, goals integer, assists integer,
  games_scored integer, shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric, card_games integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_home integer; v_away integer; v_league uuid;
begin
  select nullif(th.external_id, '')::integer, nullif(ta.external_id, '')::integer, m.league_id
    into v_home, v_away, v_league
  from public.matches m
  left join public.teams th on th.id = m.home_team_id
  left join public.teams ta on ta.id = m.away_team_id
  where m.id = p_match_id;

  if v_home is null or v_away is null then
    return;   -- unknown match, or a club with no API id: nothing to read
  end if;
  if not public.player_form_allowed(array[v_home, v_away]) then
    raise exception 'player hit rates are a paid feature'
      using errcode = '42501', hint = 'upgrade';
  end if;

  return query
    select case when f.team_api_id = v_home then 'home' else 'away' end, f.*
    from public.player_form_unchecked(array[v_home, v_away], p_last,
                                      case when p_league_only then v_league end) f;
end;
$$;

-- ── The board ────────────────────────────────────────────────────────────
-- Every player in fixtures kicking off in the next p_days, ranked on ONE
-- stat, top p_limit. A rate needs a denominator of at least half the window
-- (min 3), so a player with one covered game cannot top a board at 1/1.

-- The coming fixtures, one row per side. Not granted: the gate is applied by
-- the caller, which passes p_paid.
create or replace function public.player_board_fixtures(p_days integer, p_paid boolean)
returns table (
  match_id uuid, kickoff_at timestamptz, league text, country text,
  team_api_id integer, side text, team_name text, opponent text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.id, m.kickoff_at, l.name, l.country, x.api, x.side, x.me, x.them
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
revoke all on function public.player_board_fixtures(integer, boolean) from public, anon, authenticated;
grant execute on function public.player_board_fixtures(integer, boolean) to service_role;

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
declare
  v_paid boolean := public.current_tier() <> 'free';
  v_n    integer := greatest(1, least(coalesce(p_last, 10), 20));
  v_min  integer;
  v_ids  integer[];
begin
  if p_stat is null or p_stat not in ('sot1','sot2','shot1','shot2','card','foul1','foul2','goal') then
    raise exception 'unknown stat %', p_stat using errcode = '22023';
  end if;
  v_min := greatest(3, ceil(v_n / 2.0)::integer);

  select array_agg(distinct fx.team_api_id) into v_ids
  from public.player_board_fixtures(p_days, v_paid) fx;
  if v_ids is null then return; end if;

  return query
  with f as (select * from public.player_form_unchecked(v_ids, v_n, null)),
  scored as (
    select f.*,
      case p_stat
        when 'sot1'  then f.games_1plus_sot   when 'sot2'  then f.games_2plus_sot
        when 'shot1' then f.games_1plus_shot  when 'shot2' then f.games_2plus_shots
        when 'card'  then f.games_carded      when 'foul1' then f.games_1plus_foul
        when 'foul2' then f.games_2plus_fouls when 'goal'  then f.games_scored
      end as h,
      case when p_stat = 'card' then f.card_games
           when p_stat in ('foul1','foul2') then f.foul_games
           when p_stat = 'goal' then f.apps
           else f.shot_games end as d,
      case when p_stat in ('sot1','sot2') then f.sot_p90
           when p_stat in ('shot1','shot2') then f.shots_p90
           when p_stat in ('foul1','foul2') then f.fouls_p90
           when p_stat = 'card' then round((f.yellows + f.reds) * 90.0 / nullif(f.minutes, 0), 2)
           else round(f.goals * 90.0 / nullif(f.minutes, 0), 2) end as p90
    from f
  )
  select x.match_id, x.kickoff_at, x.league, x.country, x.side, x.team_name, x.opponent,
         s.player_id, s.player_name, s.player_position, s.apps, s.minutes,
         s.h, s.d, round(s.h::numeric / s.d, 3), s.p90
  from scored s
  join public.player_board_fixtures(p_days, v_paid) x on x.team_api_id = s.team_api_id
  where s.d >= v_min and s.h > 0
  order by s.h::numeric / s.d desc, s.h desc, s.p90 desc nulls last, s.minutes desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

revoke all on function public.player_form_match(uuid, integer, boolean) from public;
grant execute on function public.player_form_match(uuid, integer, boolean) to anon, authenticated, service_role;
revoke all on function public.player_board(text, integer, integer, integer) from public;
grant execute on function public.player_board(text, integer, integer, integer) to anon, authenticated, service_role;

comment on function public.player_form_match(uuid, integer, boolean) is
  'Both squads'' last-N player hit rates for one match (side = home/away). Paywalled like player_form: 42501 unless paid or a preview fixture. See migration 162.';
comment on function public.player_board(text, integer, integer, integer) is
  'Top players in the coming fixtures on one stat (sot1 sot2 shot1 shot2 card foul1 foul2 goal). Paid: every fixture; free/anon: preview fixtures only. See migration 162.';
