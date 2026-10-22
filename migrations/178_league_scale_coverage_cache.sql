-- APPLIED to production 22 Oct 2026 (as `league_scale_coverage_cache`).
-- league_scale_coverage() counted fixture_placement (a ~5.6 s view) on every call,
-- past the 3 s anon statement timeout, so /how-it-works §04 always failed for a
-- signed-out reader. The four counts move slowly; cache them and refresh every
-- 30 minutes. Read time as anon: 5.6 s -> 1.7 ms.
create table if not exists public.league_scale_coverage_cache (
  id boolean primary key default true check (id),
  placed_by_competition bigint not null,
  placed_by_league bigint not null,
  placed_by_opponents bigint not null,
  unplaced bigint not null,
  refreshed_at timestamptz not null default now()
);
alter table public.league_scale_coverage_cache enable row level security;
revoke all on public.league_scale_coverage_cache from anon, authenticated;

create or replace function public.refresh_league_scale_coverage()
returns void language sql security definer set search_path to 'public','pg_temp'
set statement_timeout = '60s' as $$
  insert into public.league_scale_coverage_cache as c
    (id, placed_by_competition, placed_by_league, placed_by_opponents, unplaced, refreshed_at)
  select true,
         count(*) filter (where status = 'placed' and basis = 'competition'),
         count(*) filter (where status = 'placed' and basis = 'league'),
         count(*) filter (where status = 'placed' and basis = 'opponents'),
         count(*) filter (where status = 'unplaced'),
         now()
  from public.fixture_placement
  on conflict (id) do update set
    placed_by_competition = excluded.placed_by_competition,
    placed_by_league = excluded.placed_by_league,
    placed_by_opponents = excluded.placed_by_opponents,
    unplaced = excluded.unplaced,
    refreshed_at = excluded.refreshed_at;
$$;
revoke all on function public.refresh_league_scale_coverage() from public, anon, authenticated;

select public.refresh_league_scale_coverage();

create or replace function public.league_scale_coverage()
returns table(placed_by_competition bigint, placed_by_league bigint, placed_by_opponents bigint, unplaced bigint)
language sql stable security definer set search_path to 'public','pg_temp' as $$
  select placed_by_competition, placed_by_league, placed_by_opponents, unplaced
  from public.league_scale_coverage_cache where id;
$$;

select cron.schedule('league-scale-coverage-refresh', '11,41 * * * *',
  $$select public.refresh_league_scale_coverage()$$);
