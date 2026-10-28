-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907224911, name 113_engine_run_ledger. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 113: engine_runs -- close the loop between "dispatched" and "produced".
--
-- The chain is pg_cron -> trigger-engine (edge) -> GitHub Actions
-- (oweybee/eve-engine) -> odds. Every link reported success on handoff and
-- no link reported on outcome, so 11 outages of 4h+ in 21 days (one of
-- them 24h) passed with a clean cron log.
--
-- A run is only 'produced' if bookmaker rows appeared after it fired.
-- =====================================================================

create table if not exists public.engine_runs (
  id             bigserial primary key,
  dispatched_at  timestamptz not null default now(),
  source         text not null default 'trigger-engine',
  github_status  int,
  dispatch_ok    boolean,
  attempts       int default 1,
  error          text,
  rows_written   int,
  reconciled_at  timestamptz,
  outcome        text not null default 'pending'
                 check (outcome in ('pending','produced','silent','dispatch_failed'))
);

create index if not exists engine_runs_pending
  on public.engine_runs (outcome, dispatched_at desc);
create index if not exists engine_runs_recent
  on public.engine_runs (dispatched_at desc);

comment on table public.engine_runs is
  'One row per engine dispatch, written by the trigger-engine edge function, then graded by reconcile_engine_runs(). outcome=silent means GitHub accepted the dispatch and no bookmaker row followed: that is the failure mode that ran undetected for 25h on 6 Sep 2026 while cron logged 288 successes.';

alter table public.engine_runs enable row level security;

-- Grade dispatches once enough time has passed for a run to have written.
create or replace function public.reconcile_engine_runs(grace interval default interval '12 minutes')
returns int language plpgsql as $$
declare n int;
begin
  with due as (
    select id, dispatched_at from public.engine_runs
    where outcome = 'pending' and dispatched_at < now() - grace
    limit 500
  ),
  counted as (
    select d.id,
           (select count(*) from public.odds o
            where o.bookmaker <> 'apifootball_live'
              and o.fetched_at >= d.dispatched_at
              and o.fetched_at <  d.dispatched_at + grace) as written
    from due d
  )
  update public.engine_runs er
     set rows_written  = c.written,
         reconciled_at = now(),
         outcome       = case when er.dispatch_ok is false then 'dispatch_failed'
                              when c.written > 0 then 'produced'
                              else 'silent' end
    from counted c
   where er.id = c.id;

  get diagnostics n = row_count;

  delete from public.engine_runs where dispatched_at < now() - interval '90 days';
  return n;
end $$;

comment on function public.reconcile_engine_runs(interval) is
  'Grades pending dispatches by whether bookmaker rows landed in the grace window after them. Runs on cron. Deliberately counts real books only: apifootball_live kept writing right through the 6 Sep blackout and would have masked it.';

-- Rolling reliability, for the health check and for judging whether a fix worked.
create or replace view public.v_engine_reliability as
select
  date_trunc('day', dispatched_at)::date as day,
  count(*)                                        as dispatches,
  count(*) filter (where outcome = 'produced')    as produced,
  count(*) filter (where outcome = 'silent')      as silent,
  count(*) filter (where outcome = 'dispatch_failed') as dispatch_failed,
  round(100.0 * count(*) filter (where outcome = 'produced')
        / nullif(count(*) filter (where outcome <> 'pending'),0), 1) as produced_pct
from public.engine_runs
group by 1 order by 1 desc;

