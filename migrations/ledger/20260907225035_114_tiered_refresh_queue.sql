-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225035, name 114_tiered_refresh_queue. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 114: Tiered refresh queue.
--
-- The fetcher ran a flat ~3.1h cron over whatever it picked up, which is
-- how Elche v Real Sociedad got two refreshes on matchday (12:12, 17:31)
-- and a December fixture got one in August and none since.
--
-- The Odds API bills per LEAGUE request, not per match: measured 3 Sep 2026,
-- 839 credits bought 134 league-sweeps = 6.26 credits each, matching
-- 3 markets (h2h, totals, btts) x 2 regions exactly. A league with 12
-- fixtures costs the same as a league with 1.
--
-- So cadence should be driven by the most urgent fixture in each league,
-- and leagues with nothing near kickoff should not be swept at all.
-- =====================================================================

alter table public.price_freshness_policy
  add column if not exists refresh_every interval;

-- Refresh at roughly half the freshness budget so a price is replaced
-- before it can breach the gate rather than just after.
update public.price_freshness_policy set refresh_every = interval '10 minutes' where tier='imminent';
update public.price_freshness_policy set refresh_every = interval '45 minutes' where tier='near';
update public.price_freshness_policy set refresh_every = interval '4 hours'    where tier='ahead';
update public.price_freshness_policy set refresh_every = null                  where tier='distant';

comment on column public.price_freshness_policy.refresh_every is
  'Sweep cadence for a league whose most urgent fixture sits in this tier. Set to about half the freshness budget so the gate is satisfied continuously rather than intermittently. NULL means do not sweep.';

-- What each league needs right now, driven by its most urgent fixture.
create or replace view public.v_refresh_queue as
with upcoming as (
  select m.league_id, m.id as match_id, m.kickoff_at,
         extract(epoch from (m.kickoff_at - now()))/3600.0 as hrs_to_ko
  from public.matches m
  where m.kickoff_at > now() - interval '15 minutes'
    and m.kickoff_at < now() + interval '30 days'
),
league_urgency as (
  select league_id,
         min(hrs_to_ko)                as nearest_ko_hours,
         count(*)                      as upcoming_fixtures,
         count(*) filter (where hrs_to_ko < 24) as fixtures_within_24h
  from upcoming group by league_id
),
last_seen as (
  select m.league_id, max(o.fetched_at) as last_fetched_at
  from public.odds o join public.matches m on m.id = o.match_id
  where o.bookmaker <> 'apifootball_live'
  group by m.league_id
)
select
  lu.league_id,
  l.name                                as league,
  lu.nearest_ko_hours,
  lu.upcoming_fixtures,
  lu.fixtures_within_24h,
  public.price_tier(lu.nearest_ko_hours) as tier,
  p.refresh_every,
  ls.last_fetched_at,
  round(extract(epoch from (now() - ls.last_fetched_at))/60.0, 1) as minutes_since_sweep,
  (p.refresh_every is not null
   and (ls.last_fetched_at is null
        or ls.last_fetched_at < now() - p.refresh_every))        as is_due,
  -- 3 markets x 2 regions, confirmed against billed usage
  6                                     as credits_per_sweep
from league_urgency lu
join public.price_freshness_policy p on p.tier = public.price_tier(lu.nearest_ko_hours)
left join public.leagues l on l.id = lu.league_id
left join last_seen ls on ls.league_id = lu.league_id
order by lu.nearest_ko_hours asc;

comment on view public.v_refresh_queue is
  'What the fetcher should sweep next. One row per league, tier set by its most urgent fixture, is_due driven by that tier cadence. The engine should replace "sweep everything every 3h" with "sweep where is_due", which concentrates spend on fixtures near kickoff and stops paying to refresh December.';

