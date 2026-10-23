-- 182 - follows settle on the post-match stats, never the last in-play snapshot
--
-- Review of 180, 24 Oct 2026 (found before any member had a follow):
--
-- 1. A corners/cards/shots follow settled the run a match flipped to
--    'completed', reading match_stats as the in-play loop last wrote it. That
--    snapshot can be minutes old at the whistle, so a 94th-minute corner could
--    turn a landed "Over 9.5 corners" into a permanent miss. And a corners BET
--    on the same line settles from match_extra_stats, so one match could show
--    two counts on /me.
--    Now: a MATCH total of corners or cards settles from match_extra_stats,
--    the same source settle_my_bets() grades a bet on; a TEAM stat waits until
--    both match_stats rows were fetched 150 minutes or more after kickoff (the
--    fetchMatchDetails full-time refresh). The live bar still reads the
--    in-play snapshot. The engine step also moved after fetchMatchDetails.
--
-- 2. follow_team_stat called a type "reported" only when a side had a
--    NON-NULL value, but inside a covered fixture the vendor writes zero as
--    null, so a match with no cards voided an "Under 2.5 cards" instead of
--    landing it. Now: reported when the type's key appears for either side and
--    the fixture is covered at all; a null reads as 0.
--
-- `follow_measure` (180) is left in place, unused and revoked; the rule is
-- `follow_measure_v2(…, p_match_id, p_final)`. A new name rather than a
-- changed signature so no caller can resolve to an ambiguous overload.
--
-- `export_my_data()` also returns `slip_scans` now (UK GDPR access request,
-- for the 30 days they are kept).
--
-- APPLIED to production 24 Oct 2026 and verified in a rolled-back
-- transaction: match corners 17 and cards 3 read from match_extra_stats,
-- home corners and away shots from the full-time match_stats rows.
--

create or replace function public.follow_team_stat(p_fixture text, p_side text, p_type text,
                                                   out val numeric, out present boolean)
language sql stable security definer set search_path = public, pg_catalog
as $$
  with all_v as (
    select ms.team_side, e->>'type' as typ,
           nullif(regexp_replace(e->>'value', '[^0-9.]', '', 'g'), '')::numeric as n
    from public.match_stats ms
    cross join lateral jsonb_array_elements(coalesce(ms.stats, '[]'::jsonb)) e
    where ms.fixture_id = p_fixture
  ), v as (select * from all_v where typ = p_type)
  select coalesce((select sum(coalesce(n, 0)) from v where p_side = 'both' or team_side = p_side), 0),
         exists (select 1 from v) and exists (select 1 from all_v where n is not null);
$$;
revoke all on function public.follow_team_stat(text, text, text) from public, anon, authenticated;

create or replace function public.follow_measure_v2(
  p_subject text, p_stat text, p_player integer,
  p_fixture text, p_goals_home integer, p_goals_away integer,
  p_match_id uuid, p_final boolean,
  out val numeric, out reported boolean, out played boolean)
language plpgsql stable security definer set search_path = public, pg_catalog
as $$
declare
  side text := case p_subject when 'home' then 'home' when 'away' then 'away' else 'both' end;
  t record; t2 record; lg record; ps record; x record; ko timestamptz;
begin
  played := true;
  if p_subject = 'player' then
    select * into lg from public.player_stats_fetch_log where fixture_id = p_fixture;
    if not found then reported := null; val := null; return; end if;
    -- asked, and the vendor had no player data at all: not reported, and we
    -- cannot say whether he played, so this voids as not_reported
    if coalesce(lg.players, 0) = 0 then reported := false; played := null; val := null; return; end if;
    select * into ps from public.player_match_stats where fixture_id = p_fixture and player_id = p_player;
    if not found or coalesce(ps.minutes, 0) <= 0 then
      played := false; reported := true; val := null; return;
    end if;
    case p_stat
      when 'shots'           then reported := lg.has_shots; val := coalesce(ps.shots_total, 0);
      when 'shots_on_target' then reported := lg.has_shots; val := coalesce(ps.shots_on, 0);
      when 'fouls_committed' then reported := lg.has_fouls; val := coalesce(ps.fouls_committed, 0);
      when 'fouls_drawn'     then reported := lg.has_fouls; val := coalesce(ps.fouls_drawn, 0);
      -- the vendor zero-fills cards; has_cards already requires real detail
      when 'cards'           then reported := lg.has_cards; val := coalesce(ps.yellow, 0) + coalesce(ps.red, 0);
      when 'goals'           then reported := true; val := coalesce(ps.goals, 0);
      when 'assists'         then reported := true; val := coalesce(ps.assists, 0);
    end case;
    return;
  end if;

  if p_stat = 'goals' or p_stat = 'btts' then
    if p_goals_home is null or p_goals_away is null then reported := null; val := null; return; end if;
    reported := true;
    val := case
      when p_stat = 'btts'   then case when p_goals_home > 0 and p_goals_away > 0 then 1 else 0 end
      when side = 'home'     then p_goals_home
      when side = 'away'     then p_goals_away
      else p_goals_home + p_goals_away end;
    return;
  end if;

  -- A MATCH total of corners or cards settles from match_extra_stats, the
  -- source settle_my_bets() grades a bet on.
  if p_final and p_subject = 'match' and p_stat in ('corners', 'cards') then
    select * into x from public.match_extra_stats where match_id = p_match_id;
    if not found then reported := null; val := null; return; end if;
    val := case p_stat when 'corners' then x.corners else coalesce(x.cards, x.yellow + x.red) end;
    reported := val is not null;
    return;
  end if;

  if not exists (select 1 from public.match_stats where fixture_id = p_fixture) then
    reported := null; val := null; return;
  end if;

  -- A TEAM stat settles on the full-time read: both sides fetched 150 minutes
  -- or more after kickoff, or it waits.
  if p_final then
    select kickoff_at into ko from public.matches where id = p_match_id;
    if ko is null or (select count(*) from public.match_stats ms
                      where ms.fixture_id = p_fixture and ms.fetched_at >= ko + interval '150 minutes') < 2 then
      reported := null; val := null; return;
    end if;
  end if;

  if p_stat = 'cards' then
    select * into t  from public.follow_team_stat(p_fixture, side, 'Yellow Cards');
    select * into t2 from public.follow_team_stat(p_fixture, side, 'Red Cards');
    reported := t.present or t2.present; val := t.val + t2.val;
  else
    select * into t from public.follow_team_stat(p_fixture, side, case p_stat
           when 'corners' then 'Corner Kicks'
           when 'shots' then 'Total Shots'
           when 'shots_on_target' then 'Shots on Goal' end);
    reported := t.present; val := t.val;
  end if;
end;
$$;

revoke all on function public.follow_measure_v2(text, text, integer, text, integer, integer, uuid, boolean) from public, anon, authenticated;

create or replace function public.my_follows(p_days integer default 60)
returns table (
  id uuid, source text, match_id uuid, subject text, player_api_id integer, player_name text,
  stat text, comparator text, line numeric, status text, progress numeric, void_reason text,
  alert boolean, settled_at timestamptz, created_at timestamptz,
  kickoff_at timestamptz, match_status text, minute smallint,
  goals_home smallint, goals_away smallint,
  home_name text, away_name text, home_crest text, away_crest text,
  league_name text, league_country text, reported boolean, played boolean)
language sql stable security definer set search_path = public, pg_catalog
as $$
  select f.id, f.source, f.match_id, f.subject, f.player_api_id, f.player_name,
         f.stat, f.comparator, f.line, f.status,
         case when f.status = 'open' then coalesce(fm.val, f.progress) else f.progress end,
         f.void_reason, f.alert, f.settled_at, f.created_at,
         m.kickoff_at, m.status, m.minute, m.goals_home, m.goals_away,
         th.name, ta.name, th.crest_url, ta.crest_url, l.name, l.country,
         fm.reported, fm.played
  from public.follows f
  join public.matches m on m.id = f.match_id
  left join public.teams th on th.id = m.home_team_id
  left join public.teams ta on ta.id = m.away_team_id
  left join public.leagues l on l.id = m.league_id
  left join lateral (
    select * from public.follow_measure_v2(f.subject, f.stat, f.player_api_id, m.external_id,
                                           m.goals_home, m.goals_away, m.id, false)
    where f.status = 'open' and m.kickoff_at <= now()
  ) fm on true
  where f.user_id = auth.uid()
    and f.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 60), 400)))
  order by m.kickoff_at desc, f.created_at desc;
$$;

create or replace function public.settle_follows()
returns table (settled integer, voided integer, waiting integer)
language plpgsql volatile security definer set search_path = public, pg_catalog
as $$
declare
  f record; mm record;
  n_settled integer := 0; n_void integer := 0; n_wait integer := 0;
  v_status text; v_reason text; v_val numeric;
begin
  for f in
    select fo.*, m.external_id, m.status as m_status, m.kickoff_at, m.goals_home, m.goals_away
    from public.follows fo join public.matches m on m.id = fo.match_id
    where fo.status = 'open' and m.kickoff_at < now()
    for update of fo skip locked
  loop
    v_status := null; v_reason := null; v_val := null;
    if f.m_status <> 'completed' or f.goals_home is null then
      if f.kickoff_at < now() - interval '48 hours' then v_status := 'void'; v_reason := 'postponed';
      else n_wait := n_wait + 1; continue; end if;
    else
      select * into mm from public.follow_measure_v2(f.subject, f.stat, f.player_api_id, f.external_id,
                                                     f.goals_home, f.goals_away, f.match_id, true);
      if mm.played is false then v_status := 'void'; v_reason := 'did_not_play';
      elsif mm.reported is false then v_status := 'void'; v_reason := 'not_reported';
      elsif mm.reported is null then
        if f.kickoff_at < now() - interval '36 hours' then v_status := 'void'; v_reason := 'not_reported';
        else n_wait := n_wait + 1; continue; end if;
      else
        v_val := mm.val;
        v_status := case when public.follow_hits(mm.val, f.comparator, f.line) then 'landed' else 'missed' end;
      end if;
    end if;

    update public.follows
       set status = v_status, void_reason = v_reason, settled_at = now(),
           progress = coalesce(v_val, progress)
     where id = f.id;
    if v_status = 'void' then n_void := n_void + 1; else n_settled := n_settled + 1; end if;
  end loop;
  return query select n_settled, n_void, n_wait;
end;
$$;

revoke all on function public.settle_follows() from public, anon, authenticated;
grant execute on function public.settle_follows() to service_role;

create or replace function public.export_my_data()
returns json
language sql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
  select json_build_object(
    'account',      (select row_to_json(p) from public.profiles p where p.id = auth.uid()),
    'preferences',  (select row_to_json(pr) from public.preferences pr where pr.user_id = auth.uid()),
    'bets',         (select coalesce(json_agg(b order by b.created_at), '[]'::json)
                       from public.bets b where b.user_id = auth.uid()),
    'follows',      (select coalesce(json_agg(fo order by fo.created_at), '[]'::json)
                       from public.follows fo where fo.user_id = auth.uid()),
    'slip_scans',   (select coalesce(json_agg(sc order by sc.created_at), '[]'::json)
                       from public.slip_scans sc where sc.user_id = auth.uid()),
    'bankroll_transactions', (select coalesce(json_agg(t order by t.occurred_at), '[]'::json)
                       from public.bankroll_transactions t where t.user_id = auth.uid()),
    'bookmakers',   (select coalesce(json_agg(ub), '[]'::json)
                       from public.user_bookmakers ub where ub.user_id = auth.uid()),
    'subscription', (select row_to_json(s) from public.subscriptions s where s.user_id = auth.uid()),
    'discord',      (select row_to_json(d) from public.discord_links d where d.user_id = auth.uid()),
    'exported_at',  now()
  )
  where auth.uid() is not null;
$function$;
