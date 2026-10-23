-- 183 - live player counts for followed players (Following tab)
--
-- API-Football updates /fixtures/players every minute while a match is in
-- progress. settleFollows.js now asks it, each engine run, for the live
-- fixtures a member follows a player on, and writes the counts HERE, not into
-- player_match_stats: a row in player_stats_fetch_log is what marks a fixture
-- final, and the settlement must only ever read the full-time fetch.
--
-- follow_measure_v2 reads this table only in its LIVE mode (p_final = false)
-- and only for a player with no full-time row yet. It never settles anything.
-- Rows older than three days are deleted by pg_cron.
--
-- APPLIED to production 24 Oct 2026.

create table if not exists public.player_live_stats (
  fixture_id      text        not null,
  player_id       integer     not null,
  minutes         smallint,
  shots_total     smallint,
  shots_on        smallint,
  fouls_committed smallint,
  fouls_drawn     smallint,
  yellow          smallint,
  red             smallint,
  goals           smallint,
  assists         smallint,
  fetched_at      timestamptz not null default now(),
  primary key (fixture_id, player_id)
);
alter table public.player_live_stats enable row level security;
revoke all on public.player_live_stats from anon, authenticated;

-- Live fixtures with an open player follow: what the engine asks about.
create or replace view public.follow_live_fixtures
with (security_invoker = true) as
select distinct m.id as match_id, m.external_id, m.league_id, m.kickoff_at, m.home_team_id, m.away_team_id
from public.follows f
join public.matches m on m.id = f.match_id
where f.status = 'open' and f.subject = 'player' and m.status = 'live'
  and m.external_id ~ '^[0-9]+$';
revoke all on public.follow_live_fixtures from anon, authenticated;
grant select on public.follow_live_fixtures to service_role;

select cron.schedule('player-live-stats-retention', '23 4 * * *',
  $$delete from public.player_live_stats where fetched_at < now() - interval '3 days'$$);

-- follow_measure_v2: the player branch gains its live read (only change).

create or replace function public.follow_measure_v2(
  p_subject text, p_stat text, p_player integer,
  p_fixture text, p_goals_home integer, p_goals_away integer,
  p_match_id uuid, p_final boolean,
  out val numeric, out reported boolean, out played boolean)
language plpgsql stable security definer set search_path = public, pg_catalog
as $$
declare
  side text := case p_subject when 'home' then 'home' when 'away' then 'away' else 'both' end;
  t record; t2 record; lg record; ps record; x record; ko timestamptz; lv record;
begin
  played := true;
  if p_subject = 'player' then
    select * into lg from public.player_stats_fetch_log where fixture_id = p_fixture;
    if not found then
      -- LIVE MODE ONLY: the in-play count, for the bar. Never settles.
      if not p_final then
        select * into lv from public.player_live_stats where fixture_id = p_fixture and player_id = p_player;
        if found then
          played := null; reported := null;
          val := case p_stat
            when 'shots'           then coalesce(lv.shots_total, 0)
            when 'shots_on_target' then coalesce(lv.shots_on, 0)
            when 'fouls_committed' then coalesce(lv.fouls_committed, 0)
            when 'fouls_drawn'     then coalesce(lv.fouls_drawn, 0)
            when 'cards'           then coalesce(lv.yellow, 0) + coalesce(lv.red, 0)
            when 'goals'           then coalesce(lv.goals, 0)
            when 'assists'         then coalesce(lv.assists, 0) end;
          return;
        end if;
      end if;
      reported := null; val := null; return;
    end if;
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
