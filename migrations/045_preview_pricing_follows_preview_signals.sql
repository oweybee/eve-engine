-- 045_preview_pricing_follows_preview_signals.sql
--
-- APPLIED AND VERIFIED IN PRODUCTION, 2 Aug 2026. Verified as `anon`:
--   before → 5 signals · 5 pricing rows ·  0 pricing rows for those signals
--   after  → 5 signals · 15 pricing rows · 10 pricing rows for those signals
--            (5 of 5 previewed signals now open their match detail)
-- The paid boundary held: anon still reads 15 of 359 pricing rows, 5 of 337
-- signals.
--
-- PROBLEM: the free preview is INCOHERENT, and it breaks every match link on
-- /signals for free and anonymous visitors.
--
-- Migration 034 caps free/anon at `free_preview_limit()` rows per premium
-- table, picking each table's preview independently:
--
--     preview_value_signal_ids()    → latest 5 value_signals   BY detected_at
--     preview_computed_value_ids()  → latest 5 computed_values BY computed_at
--
-- Two "latest 5" sets over different tables ordered by different columns do not
-- describe the same matches, and in practice they never intersect — the engine
-- rewrites every active match's computed_values row on each scan, so the newest
-- five pricing rows are simply whichever matches were recomputed most recently,
-- which has nothing to do with where the newest five detections landed.
-- Measured against production on 2026-08-02, as `anon`:
--
--     value_signals visible ............................ 5
--     computed_values visible .......................... 5
--     computed_values rows for those 5 signals' matches . 0
--
-- Zero. So a logged-out visitor sees five signals on /signals, clicks
-- "Detail →" on any of them, and /match/[id] finds no pricing row and renders
-- its empty state. Not an edge case — the ONLY outcome, for every previewed
-- signal, every time. AppFrame deliberately leaves /match/[id] out of
-- METERED_ROUTES so match detail "stays open as a taste"; RLS was quietly
-- closing the door the shell was holding open.
--
-- FIX: let the preview pricing FOLLOW the preview signals. A visitor permitted
-- to read a detection may read the pricing for the match that detection is
-- about. The preview stays capped — it is still bounded by the same five signal
-- rows — and the paid boundary is unchanged: everything outside those matches
-- remains Plus-only.
--
-- The allowance is ADDITIVE. `preview_computed_value_ids()` is untouched, so
-- the homepage free pick and the /feed preview keep showing exactly the rows
-- they show today; this only adds the handful of pricing rows needed to make
-- the taste navigable.

begin;

-- ── The matches the free preview's signals are about ─────────────────────────
-- SECURITY DEFINER for the same reason as 034's helpers: it reads value_signals
-- as owner, so a policy on computed_values can call it without tripping
-- Postgres' policy-recursion check, and it can only ever return a bounded id
-- set (at most free_preview_limit() distinct matches).
create or replace function public.preview_signal_match_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select distinct match_id
  from public.value_signals
  where match_id is not null
    and id in (select public.preview_value_signal_ids())
$$;

revoke all on function public.preview_signal_match_ids() from public;
grant execute on function public.preview_signal_match_ids() to anon, authenticated;

-- ── computed_values: paid, OR the latest-N preview, OR a previewed match ─────
drop policy if exists "tiered_read_computed_values" on public.computed_values;
create policy "tiered_read_computed_values" on public.computed_values
  for select to anon, authenticated
  using (
    current_tier() <> 'free'
    or id in (select public.preview_computed_value_ids())
    or match_id in (select public.preview_signal_match_ids())
  );

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY (expect the third figure to be non-zero after this runs):
--
--   set local role anon;
--   select
--     (select count(*) from value_signals)   as signals_visible,
--     (select count(*) from computed_values) as pricing_visible,
--     (select count(*) from computed_values
--       where match_id in (select match_id from value_signals))
--                                            as pricing_for_visible_signals;
--
-- ROLLBACK (restores 034's policy exactly):
--
--   begin;
--   drop policy if exists "tiered_read_computed_values" on public.computed_values;
--   create policy "tiered_read_computed_values" on public.computed_values
--     for select to anon, authenticated
--     using ( current_tier() <> 'free' or id in (select public.preview_computed_value_ids()) );
--   drop function if exists public.preview_signal_match_ids();
--   commit;
-- ─────────────────────────────────────────────────────────────────────────────
