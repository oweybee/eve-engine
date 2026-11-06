-- 195: each player's average rating over his last N games, for the match
-- page's lineup pitch (eve-frontend, 6 Nov 2026).
--
-- `player_match_stats` has RLS on and no read policy, and holds the rating
-- (98.3% of rows rated, July 2025 to now). The pitch needs one number per
-- player, so this returns exactly that and nothing else: the average, how many
-- games it is over, and the goals and yellows in those games for the markers.
--
-- GATED LIKE 047. A rating is something we computed a summary of, and the
-- lineup pitch is a Plus panel, so a free or anonymous caller gets no rows.
-- `(select current_tier())` so it is evaluated once, per migration 059.
-- Bounded: at most 40 players (two elevens and a bench) and 20 games.
-- The browser degrades to no badges while this is absent, so the two repos
-- deploy in either order.
create or replace function public.player_recent_ratings(p_player_ids integer[], p_last integer default 5)
returns table(player_id integer, avg_rating numeric, games integer, goals integer, yellows integer)
language sql stable security definer set search_path = public, pg_catalog as $$
  select x.player_id,
         round(avg(x.rating), 1),
         count(*)::int,
         coalesce(sum(x.goals), 0)::int,
         coalesce(sum(x.yellow), 0)::int
  from (
    select s.player_id, s.rating, s.goals, s.yellow,
           row_number() over (partition by s.player_id order by s.kickoff_at desc) rn
    from public.player_match_stats s
    where s.player_id = any(p_player_ids[1:40])
      and s.rating is not null and s.minutes > 0
      and s.kickoff_at < now()
  ) x
  where x.rn <= least(greatest(coalesce(p_last, 5), 1), 20)
    and (select public.current_tier()) <> 'free'
  group by x.player_id
$$;

revoke all on function public.player_recent_ratings(integer[], integer) from public;
grant execute on function public.player_recent_ratings(integer[], integer) to anon, authenticated;
