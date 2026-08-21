-- 085_model_record.sql — the settled record, per architecture, readable by anon.
--
-- WHAT THIS IS FOR. `/models` is a directory of every architecture that has
-- ever written a signal, with what its record actually is. That record lives in
-- `value_signals`, and `tiered_read_value_signals` (047) caps that table at
-- FIVE ROWS for a free or logged-out reader. So a browser computing a
-- per-architecture yield would compute it off five rows and print it as the
-- model's record — which is the failure eight page audits in this project have
-- now found in a different costume (the homepage KPI strip, /tips' counters,
-- /suggested-bets' pool, /signals' ledger head, and so on). The rule those
-- landed on is "a total we cannot trust at this tier is a total we do not
-- state", and the standing fix, named in the engine work order, is a
-- SECURITY DEFINER aggregate. This is it.
--
-- WHY IT IS A FUNCTION AND NOT A VIEW. Migration 059 found four views running
-- with their superuser owner's rights and serving RLS-free rows on the REST
-- API, and set the rule: `security_invoker = on`, without exception. A view
-- with invoker rights would inherit the five-row cap and be useless here, and a
-- definer view is the hole 059 closed. A SECURITY DEFINER FUNCTION is the
-- pattern this database already uses for exactly this — `current_tier()`,
-- `preview_match_ids()`, `preview_value_signal_ids()` are all one.
--
-- WHAT IT DISCLOSES, AND WHY THAT IS THE SAME CLASS AS WHAT IS ALREADY OPEN.
-- SETTLED ROWS ONLY, AGGREGATED. No pending row is touched, no price, no
-- selection, no match id, no per-row anything — eight numbers per architecture.
-- Settled history is not gated anywhere in this product by standing rule:
-- `match_results` is `USING (true)` over 77,438 rows INCLUDING closing prices,
-- and `performance_summary` is already anon-readable and already publishes the
-- headline yield. Only a PENDING claim is an offer, and this function cannot
-- see one.
--
-- ── WHY THE PAGE NEEDS IT: EVERY TYPED FIGURE IS STALE ─────────────────────
--
-- `model_calibration.notes` and `lib/publication.ts` both carry hand-written
-- records. Measured 21 Aug 2026 against the whole settled book:
--
--     architecture      typed claim                  measured now
--     DIXON_COLES       +7.6% over 77 settled        -4.25% over 256
--     MARKET_ANCHORED   "NO settled live bets"       119 settled
--     MARKET_CONSENSUS  -47.0% over 193 settled      -48.0% over 274
--     API_PREDICTIVE    n=53                         281 settled
--     LAMBDA_MC         no model_calibration row     173 settled
--
-- DIXON_COLES is the one architecture that earned publication on a MEASURED
-- record, and that record has since gone negative. Nothing on any surface says
-- so, because the figure that says otherwise is typed into two files. A page
-- that derived it could not go stale that way; this function is what lets one.
--
-- CLUSTERED BY FIXTURE, because the engine writes several signals per match and
-- their outcomes share one result — the unit of independence is the MATCH. Same
-- estimator `performance_summary.yield_clustered` uses, per architecture.

begin;

create or replace function public.model_record()
returns table (
  model_architecture   text,
  settled_signals      integer,
  settled_fixtures     integer,
  pending_signals      integer,
  yield_per_signal     numeric,
  yield_clustered      numeric,
  yield_z              numeric,
  avg_clv              numeric,
  avg_no_vig_clv       numeric,
  first_written        timestamptz,
  last_written         timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  -- A NULL architecture is a real cohort (17 settled rows on 21 Aug 2026,
  -- returning +26.1%) and must not vanish into a join. It is coalesced to a
  -- sentinel here rather than joined on IS NOT DISTINCT FROM, which Postgres
  -- cannot use for a FULL JOIN; the page gives it its own label, exactly as
  -- components/performance/RecordProvenance already does.
  with base as (
    select coalesce(vs.model_architecture, '(unrecorded)') as arch,
           vs.match_id, vs.result, vs.detected_odds, vs.clv, vs.no_vig_clv,
           vs.detected_at
      from public.value_signals vs
  ),
  arches as (select distinct arch from base),
  settled as (
    select * from base where result in ('win', 'loss')
  ),
  per_fixture as (
    select arch, match_id,
           avg(case when result = 'win' then (detected_odds - 1) else -1 end) as r
      from settled group by 1, 2
  ),
  clustered as (
    select arch, count(*)::int as n_fx, avg(r) as mu, stddev_samp(r) as sd
      from per_fixture group by 1
  ),
  flat as (
    select arch,
           count(*)::int as n,
           avg(case when result = 'win' then (detected_odds - 1) else -1 end) as y,
           avg(clv) filter (where clv is not null) as clv,
           avg(no_vig_clv) filter (where no_vig_clv is not null) as nvclv,
           min(detected_at) as first_at,
           max(detected_at) as last_at
      from settled group by 1
  ),
  pending as (
    select arch, count(*)::int as n
      from base where coalesce(result, 'pending') = 'pending'
     group by 1
  )
  select
    a.arch,
    coalesce(f.n, 0),
    coalesce(c.n_fx, 0),
    coalesce(p.n, 0),
    round(f.y::numeric, 4),
    round(c.mu::numeric, 4),
    -- NULL rather than a number when the sample cannot support one. A z from
    -- one fixture is not a small z, it is no z, and `theta ?? 0` has cost this
    -- project a surface already (lib/leagueScale).
    case when c.n_fx >= 2 and c.sd > 0
         then round((c.mu / (c.sd / sqrt(c.n_fx)))::numeric, 2) end,
    round(f.clv::numeric, 4),
    round(f.nvclv::numeric, 4),
    f.first_at,
    f.last_at
  from arches a
  left join flat      f on f.arch = a.arch
  left join clustered c on c.arch = a.arch
  left join pending   p on p.arch = a.arch
  order by 2 desc, 1;
$function$;

comment on function public.model_record() is
  'Per-architecture SETTLED record, aggregated. Reads value_signals as definer '
  'because 047 caps that table at five rows for a free reader — see the '
  'migration header. Settled rows only; no pending claim is visible here.';

revoke all on function public.model_record() from public;
grant execute on function public.model_record() to anon, authenticated;

-- ── Assertions, as anon, before this is allowed to commit ───────────────────
do $$
declare
  n_arch    integer;
  n_capped  integer;
  dc_yield  numeric;
begin
  set local role anon;

  select count(*) into n_arch from public.model_record();
  select count(*) into n_capped from public.value_signals;
  select yield_clustered into dc_yield
    from public.model_record() where model_architecture = 'DIXON_COLES';

  reset role;

  -- The whole point: anon sees the aggregate over every settled row while its
  -- own per-row read stays capped. If these ever agree, the cap has moved.
  if n_arch < 5 then
    raise exception '085: anon reads only % architectures — the definer is not defining', n_arch;
  end if;
  if n_capped > 100 then
    raise exception '085: value_signals is no longer capped for anon (% rows) — check 047', n_capped;
  end if;
  if dc_yield is null then
    raise exception '085: DIXON_COLES has no clustered yield — the aggregate is not aggregating';
  end if;

  raise notice '085 ok — anon: % architectures via model_record(), % value_signals rows direct, DIXON_COLES clustered yield %',
    n_arch, n_capped, dc_yield;
end $$;

commit;
