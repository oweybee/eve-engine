-- 193: who STARTED comes from the lineup, not the player-stats feed.
--
-- API-Football's fixtures/players feed sends games.substitute = false for
-- players who came off the bench (P. Mozie, 10 minutes for Annecy on 31 Oct
-- 2026, is "not a substitute"). backfillPlayerStats.js copied that flag
-- straight into is_sub, so from about 10 Oct 2026 most team-games showed 15
-- or 16 "starters", and every starts count (player_form_unchecked*) and the
-- predicted-lineup work read it as fact.
--
-- The lineups feed (startXI) is the record of who started. A trigger sets
-- is_sub from it on every write, so every writer (backfillPlayerStats.js,
-- settleFollows.js) is covered without a deploy. Where no lineup is stored,
-- the vendor flag stands. A lineup that arrives after the stats resyncs them.
-- Match on player id, then shirt number: a number is unique in one team's
-- matchday squad, and it catches the vendor's rare re-issued player ids.

create or replace function public.pms_starter_from_lineup(p_fixture text, p_team int, p_player int, p_shirt int)
returns boolean language sql stable as $$
  select exists (
    select 1 from jsonb_array_elements(x.starting_xi) e
    where (e->'player'->>'id')::int = p_player
       or (p_shirt is not null and (e->'player'->>'number')::int = p_shirt)
  )
  from (
    select starting_xi from public.lineups
    where fixture_id = p_fixture and team_id = p_team
      and starting_xi is not null and jsonb_array_length(starting_xi) >= 10
    order by confirmed desc nulls last, fetched_at desc
    limit 1
  ) x
$$;

create or replace function public.pms_is_sub_from_lineup()
returns trigger language plpgsql as $$
declare started boolean;
begin
  started := public.pms_starter_from_lineup(new.fixture_id, new.team_api_id, new.player_id, new.shirt_number);
  if started is not null then
    new.is_sub := not started;
  end if;
  return new;
end $$;

drop trigger if exists pms_is_sub_from_lineup on public.player_match_stats;
create trigger pms_is_sub_from_lineup
  before insert or update on public.player_match_stats
  for each row execute function public.pms_is_sub_from_lineup();

create or replace function public.lineups_resync_is_sub()
returns trigger language plpgsql as $$
begin
  update public.player_match_stats s
     set is_sub = not public.pms_starter_from_lineup(s.fixture_id, s.team_api_id, s.player_id, s.shirt_number)
   where s.fixture_id = new.fixture_id and s.team_api_id = new.team_id
     and public.pms_starter_from_lineup(s.fixture_id, s.team_api_id, s.player_id, s.shirt_number) is not null;
  return null;
end $$;

drop trigger if exists lineups_resync_is_sub on public.lineups;
create trigger lineups_resync_is_sub
  after insert or update of starting_xi on public.lineups
  for each row execute function public.lineups_resync_is_sub();

-- History: correct every row a stored lineup can speak for (10,400 rows on
-- 6 Nov 2026: 10,387 subs stored as starters, 13 the other way).
update public.player_match_stats s
   set is_sub = not public.pms_starter_from_lineup(s.fixture_id, s.team_api_id, s.player_id, s.shirt_number)
 where public.pms_starter_from_lineup(s.fixture_id, s.team_api_id, s.player_id, s.shirt_number) is not null
   and s.is_sub is distinct from not public.pms_starter_from_lineup(s.fixture_id, s.team_api_id, s.player_id, s.shirt_number);
