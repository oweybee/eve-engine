-- APPLIED to production 22 Oct 2026 (as `team_recent_results`).
-- The board-form sweep (eve-frontend lib/boardForm) read up to 240 days of every
-- match involving 40 clubs per request, in pages of 1,000, to keep each club's
-- last five or ten. This returns the newest p_per_team settled matches per club
-- and nothing else, in the shape that sweep's select produced. Verified against
-- the old semantics over 72 clubs: identical 568 match ids. 200 clubs: 0.29 s.
-- SECURITY INVOKER: matches and teams are both public reads.
create index if not exists idx_matches_home_team_kickoff on public.matches (home_team_id, kickoff_at desc);
create index if not exists idx_matches_away_team_kickoff on public.matches (away_team_id, kickoff_at desc);

create or replace function public.team_recent_results(
  p_team_ids uuid[], p_per_team integer default 5, p_since timestamptz default now() - interval '240 days')
returns table(id uuid, kickoff_at timestamptz, goals_home integer, goals_away integer,
  home_team_id uuid, away_team_id uuid, league_id uuid, home_team jsonb, away_team jsonb)
language sql stable set search_path to 'public', 'pg_temp' as $$
  with ids as (
    select distinct t from unnest(coalesce(p_team_ids[1:200], '{}'::uuid[])) t
  ), picked as (
    select distinct r.id from ids
    cross join lateral (
      select x.id, x.kickoff_at from (
        (select m.id, m.kickoff_at from public.matches m
          where m.home_team_id = ids.t
            and m.status in ('completed','FT','AET','PEN','FINISHED','AWD','WO')
            and m.goals_home is not null and m.goals_away is not null
            and m.kickoff_at >= p_since
          order by m.kickoff_at desc
          limit greatest(1, least(coalesce(p_per_team, 5), 40)))
        union all
        (select m.id, m.kickoff_at from public.matches m
          where m.away_team_id = ids.t
            and m.status in ('completed','FT','AET','PEN','FINISHED','AWD','WO')
            and m.goals_home is not null and m.goals_away is not null
            and m.kickoff_at >= p_since
          order by m.kickoff_at desc
          limit greatest(1, least(coalesce(p_per_team, 5), 40)))
      ) x
      order by x.kickoff_at desc
      limit greatest(1, least(coalesce(p_per_team, 5), 40))
    ) r
  )
  select m.id, m.kickoff_at, m.goals_home, m.goals_away, m.home_team_id, m.away_team_id, m.league_id,
         jsonb_build_object('name', th.name), jsonb_build_object('name', ta.name)
  from picked p
  join public.matches m on m.id = p.id
  left join public.teams th on th.id = m.home_team_id
  left join public.teams ta on ta.id = m.away_team_id
  order by m.kickoff_at desc;
$$;
grant execute on function public.team_recent_results(uuid[], integer, timestamptz) to anon, authenticated;
