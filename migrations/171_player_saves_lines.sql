-- 171: goalkeeper saves at 2+, 3+ and 4+ (owner, 20 Oct 2026: "do 2+, 3+, 4+").
--
-- Additive, no DROP (a DROP through the MCP waits on owner approval).
--
--   * sv2 joins sv3/sv4 as a rail stat: player_stat_line, player_stat_value
--     and player_stat_count learn it, and player_rail ranks it keepers only,
--     exactly as it already does sv3/sv4. 1+ is deliberately NOT offered:
--     98% of recorded keeper appearances have a save, so it ranks nobody.
--   * player_form_match_v3 is v2 plus saves for the match page panel: games
--     where the fixture reported detail (has_detail, the same flag the rail
--     reads), minutes in those games, the total, the 2+/3+/4+ hit counts and
--     a per 90 over the honest denominator. v2 is left exactly as it is.
--
-- Measured over the 120 days to 20 Oct: 6,757 keeper appearances, saves
-- recorded on 6,329, mean 3.27; 2+ 81%, 3+ 60%, 4+ 40%.

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
    when 'sv2'  then 2 when 'sv3'  then 3 when 'sv4'  then 4 when 'pas40' then 40 when 'pas50' then 50
  end;
$$;

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
    when p_stat in ('sv2','sv3','sv4') then case when g.has_detail then coalesce(s.saves, 0) end
    when p_stat in ('pas40','pas50') then case when g.has_detail then coalesce(s.passes_total, 0) end
  end::numeric;
$$;

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
    when p_stat in ('sv2','sv3','sv4')     then case when has_detail then coalesce(saves, 0) end
    when p_stat in ('pas40','pas50') then case when has_detail then coalesce(passes_total, 0) end
  end::numeric;
$$;

-- player_rail: rewritten in place from its LIVE definition, the way 168 did,
-- so the one line that changes is the only line this file can change. sv2 is
-- ranked keepers only, like sv3/sv4.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  where p.proname = 'player_rail' and p.pronamespace = 'public'::regnamespace;
  if position('v_gk    boolean := p_stat in (''sv3'',''sv4'');' in d) = 0 then
    raise exception '171: player_rail does not carry the expected keeper line';
  end if;
  d := replace(d, 'v_gk    boolean := p_stat in (''sv3'',''sv4'');',
                  'v_gk    boolean := p_stat in (''sv2'',''sv3'',''sv4'');');
  execute d;
end;
$$;

create or replace function public.player_form_unchecked_v3(
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
  games_1plus_fd integer, games_2plus_fd integer, fd_p90 numeric,
  save_games integer, save_minutes integer, saves integer,
  games_2plus_sv integer, games_3plus_sv integer, games_4plus_sv integer, saves_p90 numeric
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
    select s.*, g.has_shots, g.has_cards, g.has_fouls, g.has_detail, a.n
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
      count(*) filter (where a.has_fouls and a.fouls_drawn >= 2)::int           as games_2plus_fd,
      count(*) filter (where a.has_detail)::int                                 as save_games,
      coalesce(sum(a.minutes) filter (where a.has_detail), 0)::int              as save_minutes,
      coalesce(sum(coalesce(a.saves, 0)) filter (where a.has_detail), 0)::int   as saves,
      count(*) filter (where a.has_detail and a.saves >= 2)::int                as games_2plus_sv,
      count(*) filter (where a.has_detail and a.saves >= 3)::int                as games_3plus_sv,
      count(*) filter (where a.has_detail and a.saves >= 4)::int                as games_4plus_sv
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
         round(g.fouls_drawn * 90.0 / nullif(g.foul_minutes, 0), 2),
         g.save_games, g.save_minutes, g.saves,
         g.games_2plus_sv, g.games_3plus_sv, g.games_4plus_sv,
         round(g.saves * 90.0 / nullif(g.save_minutes, 0), 2)
  from agg g join squad q on q.player_id = g.player_id
  order by q.team_api_id, g.sot desc, g.shots desc, g.minutes desc;
$function$;

revoke all on function public.player_form_unchecked_v3(integer[], integer, uuid) from public, anon, authenticated;
grant execute on function public.player_form_unchecked_v3(integer[], integer, uuid) to service_role;

-- The gate is v1's and v2's, unchanged: paid seats read every fixture, anyone else only
-- the preview fixture, and a refusal is 42501 rather than an empty result.
create or replace function public.player_form_match_v3(
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
  games_1plus_fd integer, games_2plus_fd integer, fd_p90 numeric,
  save_games integer, save_minutes integer, saves integer,
  games_2plus_sv integer, games_3plus_sv integer, games_4plus_sv integer, saves_p90 numeric
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
    from public.player_form_unchecked_v3(array[v_home, v_away], p_last,
                                         case when p_league_only then v_league end) f;
end;
$function$;

revoke all on function public.player_form_match_v3(uuid, integer, boolean) from public;
grant execute on function public.player_form_match_v3(uuid, integer, boolean) to anon, authenticated, service_role;
