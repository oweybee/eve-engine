-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907230102, name 121_engine_run_idle_vs_silent. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 121: Distinguish idle from silent.
-- First live grading marked every dispatch 'silent'. That was my grading logic
-- being wrong, not the engine: pg_cron fires trigger-engine every 5 minutes but
-- the engine keeps its own ~3.1h sweep cadence, so most dispatches are correctly
-- no-ops. Grading those as failures gives an alert channel that cries wolf 97%
-- of the time, which is how monitoring gets muted and how you end up back at a
-- 25-hour blind spot.
-- A dispatch is 'silent' only if it wrote nothing AND a sweep was already overdue.

alter table public.engine_runs drop constraint if exists engine_runs_outcome_check;
alter table public.engine_runs add constraint engine_runs_outcome_check
  check (outcome in ('pending','produced','idle','silent','dispatch_failed'));

create or replace function public.reconcile_engine_runs(grace interval default interval '12 minutes')
returns int language plpgsql as $$
declare
  n int;
  overdue_after interval := interval '3 hours 30 minutes';
begin
  with due as (
    select id, dispatched_at from public.engine_runs
    where outcome = 'pending' and dispatched_at < now() - grace
    limit 500
  ),
  counted as (
    select d.id, d.dispatched_at,
           (select count(*) from public.odds o
             where o.bookmaker <> 'apifootball_live'
               and o.fetched_at >= d.dispatched_at
               and o.fetched_at <  d.dispatched_at + grace) as written,
           (select max(o.fetched_at) from public.odds o
             where o.bookmaker <> 'apifootball_live'
               and o.fetched_at < d.dispatched_at) as last_write_before
    from due d
  )
  update public.engine_runs er
     set rows_written  = c.written,
         reconciled_at = now(),
         outcome = case
           when er.dispatch_ok is false then 'dispatch_failed'
           when c.written > 0           then 'produced'
           when c.last_write_before is null
             or c.last_write_before < c.dispatched_at - overdue_after
                                        then 'silent'
           else                              'idle'
         end
    from counted c
   where er.id = c.id;

  get diagnostics n = row_count;
  delete from public.engine_runs where dispatched_at < now() - interval '90 days';
  return n;
end $$;

comment on function public.reconcile_engine_runs(interval) is
  'Grades pending dispatches. produced = rows landed. idle = no rows but none were due (normal: cron fires every 5 min, engine sweeps every ~3h). silent = no rows AND last write already over 3h30 old, so this dispatch owed data. dispatch_failed = GitHub refused. Only silent and dispatch_failed are faults.';

drop view if exists public.v_engine_reliability;

create view public.v_engine_reliability
with (security_invoker = true) as
select
  date_trunc('day', dispatched_at)::date as day,
  count(*) as dispatches,
  count(*) filter (where outcome='produced')        as produced,
  count(*) filter (where outcome='idle')            as idle,
  count(*) filter (where outcome='silent')          as silent,
  count(*) filter (where outcome='dispatch_failed') as dispatch_failed,
  round(100.0 * count(*) filter (where outcome in ('silent','dispatch_failed'))
        / nullif(count(*) filter (where outcome <> 'pending'),0), 1) as fault_pct
from public.engine_runs
group by 1 order by 1 desc;

revoke all on public.v_engine_reliability from anon;

update public.engine_runs
   set outcome = 'pending', reconciled_at = null, rows_written = null
 where outcome = 'silent';

