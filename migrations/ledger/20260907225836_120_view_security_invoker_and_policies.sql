-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225836, name 120_view_security_invoker_and_policies. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 120: v_refresh_queue and v_engine_reliability were created without
-- security_invoker, so they would run with the creator's rights and bypass
-- RLS for any caller. Both are operational views with no business being
-- readable by anon at all.
alter view public.v_refresh_queue      set (security_invoker = true);
alter view public.v_engine_reliability set (security_invoker = true);

revoke all on public.v_refresh_queue      from anon;
revoke all on public.v_engine_reliability from anon;
revoke all on public.engine_runs          from anon;
revoke all on public.pipeline_heartbeat   from anon;
revoke all on public.league_refresh_scope from anon;
revoke all on public.refresh_tier_occupancy from anon;

-- The board needs to read the policy thresholds to render "priced 14 min ago"
-- against its budget; that is public, non-sensitive configuration.
grant select on public.price_freshness_policy to anon, authenticated;
grant select on public.v_board_rows          to anon, authenticated;

-- Operational tables stay service-role only. RLS is on with no policy, which
-- denies anon and authenticated by design; state it explicitly so the intent
-- is not mistaken for an oversight later.
comment on table public.engine_runs is
  'One row per engine dispatch, graded by reconcile_engine_runs(). RLS enabled with NO policy on purpose: service role only. outcome=silent is the failure mode that ran undetected for 25h on 6 Sep 2026 while cron logged 288 successes.';
comment on table public.pipeline_heartbeat is
  'Outcome-based health log, written every 15 minutes. RLS enabled with NO policy on purpose: service role only. Counts rows written rather than requests sent.';

