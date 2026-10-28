-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260904093722, name definer_views_run_as_the_caller. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Two views bypassed RLS and served the result to `anon`.
--
-- Migration 059 set "security_invoker = on, without exception" on four views
-- after board_signals was found returning every published pending signal to
-- anyone holding the publishable key and the table name. These two were not in
-- that sweep. promotable_value_signals predates it (eve-engine migration 020,
-- "canonical public view for the MaxEdge frontend and BI tooling") and nothing
-- has ever read it -- which is why nobody noticed, not why it was safe.
--
-- Measured from the anon seat immediately before this ran:
--
--   value_signals (base table, RLS applies)         5   <- the free preview
--   promotable_value_signals (DEFINER)             29   <- 24 past the paywall
--   signal_health_check (DEFINER)                   1   <- an aggregate row
--
-- Every promotable_value_signals row is `result = 'pending'` on a fixture that
-- has not kicked off -- an OPEN OFFER -- carrying detected_odds, detected_edge,
-- detected_mes, mxs, mxs_band, a derived model_probability, the bookmaker, both
-- clubs and the league. That is the product, and migration 047 caps it at five
-- rows for a free reader precisely so it is not free.
--
-- signal_health_check is lower severity and the same mechanism: no offer and no
-- price, but it publishes live_candidates and prime_band_candidates -- counts
-- of open signals, which is exactly the total PreviewNote refuses to state.
--
-- performance_signals IS NOT TOUCHED and must stay DEFINER. It is the public
-- settled record app/performance/page.tsx documents in its own header, and
-- settled history is not gated anywhere in this product.
--
-- Nothing that can read these today loses a row: service_role and postgres both
-- carry rolbypassrls, so a BI tool or engine job on the service key is
-- unaffected. Only anon and authenticated change, which is the point. Verified
-- by grep across both repos: no application code reads either view.
--
-- Reversible: alter view <name> set (security_invoker = off);

alter view public.promotable_value_signals set (security_invoker = on);
alter view public.signal_health_check      set (security_invoker = on);

-- Assert before committing. A view that still bypasses RLS, or a settled record
-- that stopped being public, both fail here rather than in somebody's browser.
do $$
declare
  n_promotable int;
  n_health     int;
  n_base       int;
  n_settled    int;
begin
  set local role anon;
  select count(*) into n_promotable from public.promotable_value_signals;
  select count(*) into n_health     from public.signal_health_check;
  select count(*) into n_base       from public.value_signals;
  select count(*) into n_settled    from public.performance_signals;
  reset role;

  if n_promotable > n_base then
    raise exception
      'promotable_value_signals still serves anon % rows against a base read of %',
      n_promotable, n_base;
  end if;

  -- The settled record is public on purpose and must not have been caught up
  -- in this. 1,101 rows the moment before; any collapse means the wrong view
  -- moved.
  if n_settled < 1000 then
    raise exception 'performance_signals fell to % rows -- the wrong view changed', n_settled;
  end if;

  raise notice 'anon now sees: promotable=% health=% base=% settled=%',
    n_promotable, n_health, n_base, n_settled;
end $$;
