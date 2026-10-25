-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260928113112, name league_base_rates_view. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- /stats reads this and nothing else. The aggregation is jsonb extraction over
-- match_stats (two rows per fixture, one per side) summed to a per-match total,
-- then averaged per league. Doing it in the browser would mean shipping every
-- stats row to the client to compute fifteen numbers.
--
-- A LEAGUE WITH NO STATS IS EXCLUDED RATHER THAN SHOWN EMPTY. The feed carries
-- fixtures for more competitions than it carries statistics for (England's
-- National League has 120 fixtures and no stats at all), and a row of dashes
-- reads as "nothing happened" rather than "we do not have this".
create or replace view public.v_league_base_rates as
with per_fixture as (
  select ms.fixture_id,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Corner Kicks'  and e->>'value' ~ '^[0-9]+$')) as corners,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Yellow Cards'  and e->>'value' ~ '^[0-9]+$')) as yellows,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Total Shots'   and e->>'value' ~ '^[0-9]+$')) as shots,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Shots on Goal' and e->>'value' ~ '^[0-9]+$')) as shots_on_target,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Fouls'         and e->>'value' ~ '^[0-9]+$')) as fouls,
         sum((select (e->>'value')::numeric from jsonb_array_elements(ms.stats) e
              where e->>'type' = 'Offsides'      and e->>'value' ~ '^[0-9]+$')) as offsides
  from public.match_stats ms
  group by 1
)
select l.id                                   as league_id,
       l.name                                 as league,
       l.country                              as country,
       count(*)::int                          as games,
       round(avg(p.corners), 2)::numeric      as corners,
       round(avg(p.yellows), 2)::numeric      as yellows,
       round(avg(p.shots), 2)::numeric        as shots,
       round(avg(p.shots_on_target), 2)::numeric as shots_on_target,
       round(avg(p.fouls), 2)::numeric        as fouls,
       round(avg(p.offsides), 2)::numeric     as offsides,
       round(avg(m.goals_home + m.goals_away), 2)::numeric as goals,
       max(ms_max.fetched_at)                 as last_fetch
from per_fixture p
join public.matches m  on m.external_id = p.fixture_id
join public.leagues l  on l.id = m.league_id
join lateral (select max(fetched_at) as fetched_at from public.match_stats s where s.fixture_id = p.fixture_id) ms_max on true
where p.corners is not null
group by l.id, l.name, l.country
having count(*) >= 20;

comment on view public.v_league_base_rates is
  'Per-league per-match base rates from match_stats. Backs /stats. Leagues with fewer than 20 fixtures of statistics are excluded: a mean over a handful of games is noise presented as a rate.';

grant select on public.v_league_base_rates to anon, authenticated;

