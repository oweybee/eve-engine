-- 170: player_form_match_v2, the match page's Player Stats panel after the
-- 20 Oct 2026 rework (owner: one stat at a time, Apps + minutes, Total,
-- Per 90, 1+ and 2+).
--
-- Additive. 162's player_form_match / player_form_unchecked are left exactly
-- as they are, so the live panel keeps working until the frontend switches,
-- and nothing has to be dropped (a DROP through the MCP waits on owner
-- approval and times out unanswered).
--
-- What v2 adds over v1:
--   * games_1plus_fd / games_2plus_fd / fd_p90: fouls WON as a hit rate, the
--     "Fouled" chip. v1 only carried the total.
--   * card_minutes: minutes in games where cards were reported, so a cards
--     per 90 has the same honest denominator as shots and fouls.
--   * player_name is the LONGEST name the feed has sent for that player id.
--     The feed alternates "G. Mancini" and "Gianluca Mancini" fixture to
--     fixture, and v1 took whichever came last, so one squad read half short
--     names and half full ones.

create or replace function public.player_form_unchecked_v2(
  p_team_api_ids integer[], p_last integer default 10, p_league_id uuid default null
)
returns table(
  player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer,
  goals integer, assists integer, games_scored integer,
  shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric,
  card_games integer, card_minutes integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric,
  games_1plus_fd integer, games_2plus_fd integer, fd_p90 numeric
)
language sql stable security definer
set search_path to 'public'
as $function$
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
    select l.player_id, l.team_api_id, l.team_name, l.player_position,
      coalesce((
        select s2.player_name
        from public.player_match_stats s2
        where s2.player_id = l.player_id and s2.player_name is not null
          and s2.kickoff_at > now() - interval '240 days'
        order by length(s2.player_name) desc, s2.kickoff_at desc
        limit 1
      ), l.player_name) as player_name
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
      coalesce(sum(a.minutes) filter (where a.has_cards), 0)::int               as card_minutes,
      coalesce(sum(coalesce(a.yellow, 0)) filter (where a.has_cards), 0)::int   as yellows,
      coalesce(sum(coalesce(a.red, 0))    filter (where a.has_cards), 0)::int   as reds,
      count(*) filter (where a.has_cards and (a.yellow > 0 or a.red > 0))::int  as games_carded,
      count(*) filter (where a.has_fouls)::int                                  as foul_games,
      coalesce(sum(a.minutes) filter (where a.has_fouls), 0)::int               as foul_minutes,
      coalesce(sum(coalesce(a.fouls_committed, 0)) filter (where a.has_fouls), 0)::int as fouls_committed,
      coalesce(sum(coalesce(a.fouls_drawn, 0))     filter (where a.has_fouls), 0)::int as fouls_drawn,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 1)::int       as games_1plus_foul,
      count(*) filter (where a.has_fouls and a.fouls_committed >= 2)::int       as games_2plus_fouls,
      count(*) filter (where a.has_fouls and a.fouls_drawn >= 1)::int           as games_1plus_fd,
      count(*) filter (where a.has_fouls and a.fouls_drawn >= 2)::int           as games_2plus_fd
    from apps a
    group by a.player_id
  )
  select q.player_id, q.player_name, q.team_api_id, q.team_name, q.player_position,
         g.last_kickoff, g.apps, g.starts, g.minutes, g.goals, g.assists, g.games_scored,
         g.shot_games, g.shot_minutes, g.shots, g.sot,
         g.games_1plus_shot, g.games_2plus_shots, g.games_1plus_sot, g.games_2plus_sot,
         round(g.shots * 90.0 / nullif(g.shot_minutes, 0), 2),
         round(g.sot   * 90.0 / nullif(g.shot_minutes, 0), 2),
         g.card_games, g.card_minutes, g.yellows, g.reds, g.games_carded,
         g.foul_games, g.foul_minutes, g.fouls_committed, g.fouls_drawn,
         g.games_1plus_foul, g.games_2plus_fouls,
         round(g.fouls_committed * 90.0 / nullif(g.foul_minutes, 0), 2),
         g.games_1plus_fd, g.games_2plus_fd,
         round(g.fouls_drawn * 90.0 / nullif(g.foul_minutes, 0), 2)
  from agg g join squad q on q.player_id = g.player_id
  order by q.team_api_id, g.sot desc, g.shots desc, g.minutes desc;
$function$;

revoke all on function public.player_form_unchecked_v2(integer[], integer, uuid) from public, anon, authenticated;
grant execute on function public.player_form_unchecked_v2(integer[], integer, uuid) to service_role;

-- The gate is v1's, unchanged: paid seats read every fixture, anyone else only
-- the preview fixture, and a refusal is 42501 rather than an empty result.
create or replace function public.player_form_match_v2(
  p_match_id uuid, p_last integer default 10, p_league_only boolean default false
)
returns table(
  side text, player_id integer, player_name text, team_api_id integer, team_name text, player_position text,
  last_kickoff timestamptz, apps integer, starts integer, minutes integer,
  goals integer, assists integer, games_scored integer,
  shot_games integer, shot_minutes integer, shots integer, sot integer,
  games_1plus_shot integer, games_2plus_shots integer, games_1plus_sot integer, games_2plus_sot integer,
  shots_p90 numeric, sot_p90 numeric,
  card_games integer, card_minutes integer, yellows integer, reds integer, games_carded integer,
  foul_games integer, foul_minutes integer, fouls_committed integer, fouls_drawn integer,
  games_1plus_foul integer, games_2plus_fouls integer, fouls_p90 numeric,
  games_1plus_fd integer, games_2plus_fd integer, fd_p90 numeric
)
language plpgsql stable security definer
set search_path to 'public', 'pg_catalog'
as $function$
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
    return;
  end if;
  if not public.player_form_allowed(array[v_home, v_away]) then
    raise exception 'player hit rates are a paid feature'
      using errcode = '42501', hint = 'upgrade';
  end if;

  return query
    select case when f.team_api_id = v_home then 'home' else 'away' end, f.*
    from public.player_form_unchecked_v2(array[v_home, v_away], p_last,
                                         case when p_league_only then v_league end) f;
end;
$function$;

revoke all on function public.player_form_match_v2(uuid, integer, boolean) from public;
grant execute on function public.player_form_match_v2(uuid, integer, boolean) to anon, authenticated, service_role;
