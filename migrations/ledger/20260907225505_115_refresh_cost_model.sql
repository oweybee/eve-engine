-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225505, name 115_refresh_cost_model. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 115: Refresh cost model.
--
-- Billing is per LEAGUE request, not per match: 839 credits bought 134
-- league-sweeps on 3 Sep 2026 (6.26 each), matching 3 markets x 2 regions.
-- So daily cost = (leagues occupying a tier) x (sweeps per day) x 6.
--
-- Tier occupancy measured by simulation over the next 14 days at hourly
-- resolution against the real fixture calendar. Stored rather than
-- recomputed because the simulation is expensive and the shape is stable.
-- =====================================================================

create table if not exists public.refresh_tier_occupancy (
  scope        text not null,     -- 'all' | 'top20' | 'top12'
  tier         text not null,
  avg_leagues  numeric not null,
  measured_at  timestamptz not null default now(),
  primary key (scope, tier)
);

comment on table public.refresh_tier_occupancy is
  'Average number of leagues sitting in each refresh tier at a given moment, by league scope. Measured 7 Sep 2026 over a 14-day forward calendar at hourly ticks. Re-measure when the fixture calendar changes shape (mid-season vs international break).';

insert into public.refresh_tier_occupancy (scope, tier, avg_leagues) values
  ('all','imminent',2.86),('all','near',10.73),('all','ahead',18.68),
  ('top20','imminent',1.30),('top20','near',5.10),('top20','ahead',8.79),
  ('top12','imminent',0.66),('top12','near',2.53),('top12','ahead',4.44)
on conflict (scope, tier) do update set avg_leagues = excluded.avg_leagues, measured_at = now();

alter table public.refresh_tier_occupancy enable row level security;

create or replace function public.estimate_refresh_credits(
  p_scope           text,
  p_imminent_min    numeric,   -- null = do not sweep this tier
  p_near_min        numeric,
  p_ahead_min       numeric,
  p_credits_per_sweep numeric default 6
) returns table (tier text, avg_leagues numeric, cadence_min numeric,
                 sweeps_per_day numeric, credits_per_day numeric)
language sql stable as $$
  select o.tier,
         o.avg_leagues,
         c.cadence,
         round(o.avg_leagues * 1440.0 / c.cadence, 1),
         round(o.avg_leagues * 1440.0 / c.cadence * p_credits_per_sweep, 0)
  from public.refresh_tier_occupancy o
  join lateral (
    select case o.tier when 'imminent' then p_imminent_min
                       when 'near'     then p_near_min
                       when 'ahead'    then p_ahead_min end as cadence
  ) c on true
  where o.scope = p_scope and c.cadence is not null
  order by case o.tier when 'imminent' then 1 when 'near' then 2 else 3 end;
$$;

comment on function public.estimate_refresh_credits(text,numeric,numeric,numeric,numeric) is
  'Daily credit cost of a candidate cadence policy. Cadence in minutes per tier, NULL to skip a tier. Use before changing price_freshness_policy.refresh_every: the monthly budget is 100,000 credits with an 8% reserve, so 92,000 allocatable is about 3,066/day.';

