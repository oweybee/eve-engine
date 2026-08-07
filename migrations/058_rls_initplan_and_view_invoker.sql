-- 058_rls_initplan_and_view_invoker.sql
--
-- Two launch-eve corrections, both found by measuring production rather than
-- reading the schema. Neither changes who may see what: every predicate below
-- is logically identical to the one it replaces, and the view change makes the
-- database enforce a rule it was previously being asked to take on trust.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — current_tier() was being called once PER ROW, not once per query.
--
-- Every `tiered_read_*` policy from 047 reads `current_tier() <> 'free'`.
-- current_tier() is STABLE, takes no arguments, and does a lookup on profiles.
-- Postgres does NOT hoist a bare STABLE call out of a row filter, so it ran
-- once for every row the scan touched — a profiles lookup per candidate row,
-- on every read, for every visitor.
--
-- Measured on production, 7 Aug 2026, as the anon role:
--
--   next-50-fixtures on `matches` (walks 9,496 rows to return 29)
--     before  692 ms      after  12.5 ms      55x
--   opening h2h prices on `odds_snapshots` (692k rows, the real query shape
--   lib/bestPrice.js issues — filtered by match_id, not a scan)
--     before  570 ms      after   7.7 ms      74x   (1,104 rows both ways)
--
-- The fix is to wrap the call in a scalar subquery. `(select current_tier())`
-- has no correlation to the row, so the planner evaluates it once as an
-- InitPlan and compares a constant thereafter. This is Supabase's own
-- documented RLS guidance, and it is why every `auth.uid()` in this database is
-- already written `(select auth.uid())` — the same treatment simply never
-- reached current_tier().
--
-- SEMANTICS ARE UNCHANGED. A no-argument STABLE function evaluated once per
-- statement returns what it returns once per row: the caller's tier cannot
-- change mid-statement. Row counts were compared before and after on every
-- table below and are identical. This is a planner hint, not a policy change —
-- do not read it as a relaxation of 047.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — board_signals handed the paid board to anonymous visitors.
--
-- 048 created `board_signals` as a plain view. A view runs with its OWNER's
-- rights unless told otherwise, and this one is owned by a superuser, so it
-- read `value_signals` with RLS bypassed entirely — then exposed the result on
-- the REST API with `anon: SELECT` granted. Measured as anon on 7 Aug 2026: 5
-- rows returned, and all 5 were rows `preview_value_signal_ids()` specifically
-- withholds. Not an overlap with the free preview — disjoint from it. Anyone
-- with the publishable key and the table name could read the full published
-- board: price, model probability, gap and stake units.
--
-- It went unnoticed because no surface reads the view, and the frontend gate
-- (lib/publication.ts) is applied in the query layer. But a REST endpoint does
-- not need a caller in our app — being unread by our own code is not a control.
--
-- `security_invoker = on` makes the view run as whoever queries it, so the
-- 047 policy on the base table applies through it. Verified after the change:
-- anon 0 rows, and a Plus member still sees all 5 (the policy's first branch,
-- `current_tier() <> 'free'`, is unaffected). The other three views get the
-- same treatment: they are internal reporting surfaces that were readable by
-- anon for the same reason, and nothing in either repo reads them.
--
-- NOTE: board_signals was already set to security_invoker=on directly against
-- production during the 7 Aug audit. The statement is repeated here so this
-- file remains the complete record of the change; it is idempotent.

begin;

-- ── Part 1: hoist current_tier() into an InitPlan ────────────────────────────

alter policy tiered_read_matches on public.matches
  using ((select current_tier()) <> 'free'
         or id in (select preview_match_ids()));

alter policy tiered_read_odds on public.odds
  using ((select current_tier()) <> 'free'
         or match_id in (select preview_priced_match_ids()));

alter policy tiered_read_odds_snapshots on public.odds_snapshots
  using ((select current_tier()) <> 'free'
         or match_id in (select preview_priced_match_ids()));

alter policy tiered_read_value_signals on public.value_signals
  using ((select current_tier()) <> 'free'
         or id in (select preview_value_signal_ids()));

alter policy tiered_read_computed_values on public.computed_values
  using ((select current_tier()) <> 'free'
         or id in (select preview_computed_value_ids())
         or match_id in (select preview_signal_match_ids()));

alter policy tiered_read_recommendations on public.recommendations
  using ((select current_tier()) <> 'free'
         or id in (select preview_recommendation_ids()));

alter policy tiered_read_suggested_accas on public.suggested_accas
  using ((select current_tier()) <> 'free'
         or id in (select preview_suggested_acca_ids()));

alter policy tiered_read_match_stats on public.match_stats
  using ((select current_tier()) <> 'free'
         or fixture_id in (select preview_fixture_external_ids()));

alter policy tiered_read_inplay_market_series on public.inplay_market_series
  using ((select current_tier()) <> 'free'
         or match_id in (select preview_priced_match_ids()));

alter policy paid_read_fixture_predictions on public.fixture_predictions
  using ((select current_tier()) <> 'free');

-- The 30-day ledger window for free members. auth.uid() is already hoisted
-- here; current_tier() was not.
alter policy bets_select_own on public.bets
  using ((select auth.uid()) = user_id
         and (created_at >= now() - interval '30 days'
              or (select current_tier()) <> 'free'));

-- ── Part 2: views enforce the caller's RLS, not the owner's ──────────────────

alter view public.board_signals      set (security_invoker = on);
alter view public.paper_trade_report set (security_invoker = on);
alter view public.mx_coverage        set (security_invoker = on);
alter view public.team_alias_lookup  set (security_invoker = on);

commit;
