-- 163 — player_hit_rail(): the Players sliders' read (owner, 19 Oct 2026).
--
-- The /hit-rate Players tab draws one slider per stat in the team board's
-- card shape, and that card carries a RUN of dots. player_board() (162)
-- returns the aggregate only, so this wraps it and adds each player's run on
-- the stat, oldest first: true / false per game, NULL where the feed did not
-- record that stat for the game (the same per-fixture coverage flags 160's
-- player_form uses, so the dots and the dial share one denominator).
--
-- Gate: inherited. It calls player_board(), which filters to the preview
-- fixtures for a free or signed-out reader. Applied to the live DB 19 Oct.
-- player_board() is kept (callers may still use it); drop it once nothing does.

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
  v_n integer := greatest(1, least(coalesce(p_last, 10), 20));
begin
  return query
  with ranked as (
    select * from public.player_board(p_stat, v_n, p_days, greatest(1, least(coalesce(p_limit, 20), 60)))
  )
  select r.match_id, r.kickoff_at, r.league, r.country, r.side, r.team_name, r.opponent,
         r.player_id, r.player_name, r.player_position, r.apps, r.minutes, r.hits, r.games, r.rate, r.per90,
         (
           select coalesce(jsonb_agg(q.h order by q.kickoff_at), '[]'::jsonb)
           from (
             select s.kickoff_at,
               case p_stat
                 when 'sot1'  then case when g.has_shots then coalesce(s.shots_on, 0) >= 1 end
                 when 'sot2'  then case when g.has_shots then coalesce(s.shots_on, 0) >= 2 end
                 when 'shot1' then case when g.has_shots then coalesce(s.shots_total, 0) >= 1 end
                 when 'shot2' then case when g.has_shots then coalesce(s.shots_total, 0) >= 2 end
                 when 'goal'  then coalesce(s.goals, 0) > 0
                 when 'card'  then case when g.has_cards then coalesce(s.yellow, 0) + coalesce(s.red, 0) > 0 end
                 when 'foul1' then case when g.has_fouls then coalesce(s.fouls_committed, 0) >= 1 end
                 when 'foul2' then case when g.has_fouls then coalesce(s.fouls_committed, 0) >= 2 end
               end as h
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

revoke all on function public.player_hit_rail(text, integer, integer, integer) from public;
grant execute on function public.player_hit_rail(text, integer, integer, integer) to anon, authenticated, service_role;
