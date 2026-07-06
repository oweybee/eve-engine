-- 034_tiered_premium_access.sql
--
-- ⚠️  STAGED FOR REVIEW — NOT YET APPLIED TO PRODUCTION.  ⚠️
--     Apply with the Supabase SQL editor / CLI once you're happy with the
--     preview size (see free_preview_limit() below). See FULL_SITE_AUDIT §C1.
--
-- PROBLEM (Critical): the premium prediction tables were readable in full by
-- anyone. Their SELECT policies were `USING (true)` granted to anon/public, and
-- the intelligence pages fetch them client-side with the public anon key, so the
-- paywall (MeteredGate) was purely cosmetic CSS clipping. A logged-out user
-- could dump every paid signal with `GET /rest/v1/value_signals?select=*`.
--
-- FIX: gate the premium tables by subscription tier at the database, mirroring
-- the pattern already used for `bets` (which enforces the free 30-day window via
-- current_tier() in its policy):
--   • Paid tiers  (current_tier() <> 'free')  → full access to everything.
--   • Free / anon                             → a capped "latest N" preview so
--     the marketing taste and the MeteredGate upsell still work.
--
-- Because logged-in requests already carry the user's Supabase JWT through
-- supabase-js, current_tier() resolves server-side automatically — so PAID
-- ACCESS NEEDS NO FRONTEND CHANGE. Free/anon users simply receive the preview
-- subset instead of the full dataset.
--
-- The "latest N" preview is implemented via SECURITY DEFINER helper functions
-- rather than an inline `id in (select … from same_table limit N)`, which would
-- trip Postgres' "infinite recursion detected in policy" on a self-reference.
-- The helpers run as owner (bypassing RLS) and only ever return a bounded id set.

begin;

-- ── The one knob: how many rows the free/anon preview exposes per surface ─────
create or replace function public.free_preview_limit()
returns integer language sql immutable as $$ select 5 $$;

-- ── Latest-N id helpers (owner-run, bypass RLS, return a capped id set) ───────
create or replace function public.preview_value_signal_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select id from public.value_signals
  order by detected_at desc nulls last
  limit public.free_preview_limit()
$$;

create or replace function public.preview_computed_value_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select id from public.computed_values
  order by computed_at desc nulls last
  limit public.free_preview_limit()
$$;

create or replace function public.preview_recommendation_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select id from public.recommendations
  order by recommendation_timestamp desc nulls last
  limit public.free_preview_limit()
$$;

create or replace function public.preview_suggested_acca_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select id from public.suggested_accas
  order by created_at desc nulls last
  limit public.free_preview_limit()
$$;

revoke all on function
  public.free_preview_limit(),
  public.preview_value_signal_ids(),
  public.preview_computed_value_ids(),
  public.preview_recommendation_ids(),
  public.preview_suggested_acca_ids()
from public;
grant execute on function
  public.free_preview_limit(),
  public.preview_value_signal_ids(),
  public.preview_computed_value_ids(),
  public.preview_recommendation_ids(),
  public.preview_suggested_acca_ids()
to anon, authenticated;

-- ── value_signals ────────────────────────────────────────────────────────────
drop policy if exists "anon_read" on public.value_signals;
create policy "tiered_read_value_signals" on public.value_signals
  for select to anon, authenticated
  using ( current_tier() <> 'free' or id in (select public.preview_value_signal_ids()) );

-- ── computed_values (drives the feed cards) ──────────────────────────────────
drop policy if exists "public read computed_values" on public.computed_values;
create policy "tiered_read_computed_values" on public.computed_values
  for select to anon, authenticated
  using ( current_tier() <> 'free' or id in (select public.preview_computed_value_ids()) );

-- ── recommendations ──────────────────────────────────────────────────────────
drop policy if exists "anon_read" on public.recommendations;
create policy "tiered_read_recommendations" on public.recommendations
  for select to anon, authenticated
  using ( current_tier() <> 'free' or id in (select public.preview_recommendation_ids()) );

-- ── suggested_accas ──────────────────────────────────────────────────────────
drop policy if exists "anon_read" on public.suggested_accas;
create policy "tiered_read_suggested_accas" on public.suggested_accas
  for select to anon, authenticated
  using ( current_tier() <> 'free' or id in (select public.preview_suggested_acca_ids()) );

-- ── fixture_predictions (37k rows of raw model predictions — paid-only) ───────
-- Not a "taste" surface; expose to paid tiers only, no preview.
drop policy if exists "anon_read" on public.fixture_predictions;
create policy "paid_read_fixture_predictions" on public.fixture_predictions
  for select to authenticated
  using ( current_tier() <> 'free' );

-- NOTE: the service_role policies (engine writes) are unaffected — the engine
-- uses the service-role key which bypasses RLS entirely.

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (if you need to revert to the previous fully-open behaviour):
--
--   begin;
--   drop policy if exists "tiered_read_value_signals"     on public.value_signals;
--   drop policy if exists "tiered_read_computed_values"   on public.computed_values;
--   drop policy if exists "tiered_read_recommendations"   on public.recommendations;
--   drop policy if exists "tiered_read_suggested_accas"   on public.suggested_accas;
--   drop policy if exists "paid_read_fixture_predictions" on public.fixture_predictions;
--   create policy "anon_read" on public.value_signals      for select to anon, authenticated using (true);
--   create policy "public read computed_values" on public.computed_values for select to public using (true);
--   create policy "anon_read" on public.recommendations    for select to anon, authenticated using (true);
--   create policy "anon_read" on public.suggested_accas    for select to anon, authenticated using (true);
--   create policy "anon_read" on public.fixture_predictions for select to anon, authenticated using (true);
--   commit;
-- ─────────────────────────────────────────────────────────────────────────────
