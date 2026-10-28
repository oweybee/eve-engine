-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225635, name 116_core_league_scope. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 116: Core league scope (scenario S5). See migration notes below.
--   S2 tight everywhere (10/45/240) .... 156,090/mo  OVER the 92,000 allocatable
--   S3 relaxed everywhere (15/90/720) ... 87,030/mo  fits, 2h stale near kickoff
--   S5 tight on core, slow tail ......... 42,150/mo  fits, CHEAPER than today's 45,030
-- Billing is per league sweep, so 10-minute freshness on 12 leagues costs
-- less than 3-hourly freshness on 40.

create table if not exists public.league_refresh_scope (
  league_id   uuid primary key references public.leagues(id),
  is_core     boolean not null default false,
  rank        int,
  signals_90d int,
  set_at      timestamptz not null default now()
);

comment on table public.league_refresh_scope is
  'Which leagues get tight refresh cadence. Core = leagues that actually produce published signals, so credits follow signal supply rather than spreading evenly over 40 leagues. Re-rank when the season shape changes.';

alter table public.league_refresh_scope enable row level security;

with sig as (
  select m.league_id, count(*) c
  from public.value_signals vs
  join public.matches m on m.id = vs.match_id
  where vs.detected_at > now() - interval '90 days'
    and vs.model_architecture <> 'INPLAY_DIXON_COLES'
  group by 1
),
ranked as (select league_id, c, row_number() over (order by c desc) rk from sig)
insert into public.league_refresh_scope (league_id, is_core, rank, signals_90d)
select league_id, rk <= 12, rk, c from ranked
on conflict (league_id) do update
  set is_core = excluded.is_core, rank = excluded.rank,
      signals_90d = excluded.signals_90d, set_at = now();

update public.price_freshness_policy set refresh_every = interval '10 minutes' where tier='imminent';
update public.price_freshness_policy set refresh_every = interval '45 minutes' where tier='near';
update public.price_freshness_policy set refresh_every = interval '12 hours'   where tier='ahead';
update public.price_freshness_policy set max_price_age = interval '14 hours'   where tier='ahead';

drop view if exists public.v_refresh_queue;

create view public.v_refresh_queue as
with upcoming as (
  select m.league_id, m.kickoff_at,
         extract(epoch from (m.kickoff_at - now()))/3600.0 as hrs_to_ko
  from public.matches m
  where m.kickoff_at > now() - interval '15 minutes'
    and m.kickoff_at < now() + interval '30 days'
),
league_urgency as (
  select league_id, min(hrs_to_ko) as nearest_ko_hours,
         count(*) as upcoming_fixtures,
         count(*) filter (where hrs_to_ko < 24) as fixtures_within_24h
  from upcoming group by league_id
),
last_seen as (
  select m.league_id, max(o.fetched_at) as last_fetched_at
  from public.odds o join public.matches m on m.id = o.match_id
  where o.bookmaker <> 'apifootball_live'
  group by m.league_id
),
resolved as (
  select lu.league_id, lu.nearest_ko_hours, lu.upcoming_fixtures, lu.fixtures_within_24h,
         l.name as league,
         coalesce(sc.is_core,false) as is_core, sc.rank as signal_rank,
         public.price_tier(lu.nearest_ko_hours) as tier,
         case when coalesce(sc.is_core,false) then p.refresh_every
              else (select refresh_every from public.price_freshness_policy where tier='ahead')
         end as refresh_every,
         ls.last_fetched_at
  from league_urgency lu
  join public.price_freshness_policy p on p.tier = public.price_tier(lu.nearest_ko_hours)
  left join public.leagues l on l.id = lu.league_id
  left join public.league_refresh_scope sc on sc.league_id = lu.league_id
  left join last_seen ls on ls.league_id = lu.league_id
)
select league_id, league, is_core, signal_rank, nearest_ko_hours, tier,
       upcoming_fixtures, fixtures_within_24h, refresh_every, last_fetched_at,
       round(extract(epoch from (now()-last_fetched_at))/60.0,1) as minutes_since_sweep,
       (refresh_every is not null
        and (last_fetched_at is null or last_fetched_at < now() - refresh_every)) as is_due,
       6 as credits_per_sweep
from resolved
order by is_core desc, nearest_ko_hours asc;

comment on view public.v_refresh_queue is
  'What the fetcher should sweep next. One row per league. Core leagues use their tier cadence; the tail falls back to the ahead cadence whatever its tier. Replace "sweep everything every 3h" with "sweep where is_due", in this order.';

