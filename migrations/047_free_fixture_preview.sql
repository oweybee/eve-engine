-- 047_free_fixture_preview.sql
--
-- APPLIED to production 2026-08-02, on the founder's go-ahead, and verified in
-- rolled-back transactions as the `anon` role before and after:
--   matches 49,351 -> 40 · odds 87,748 -> 822 · odds_snapshots 477,066 -> 4,037
--   computed_values UNCHANGED at 10 — this migration must not move 034's numbers
--   league_directory narrows to 14 for free readers, and the frontend no longer
--   quotes its row count — see the note in the policy block
--
-- PROBLEM. Migration 034 gated the four premium tables — value_signals,
-- computed_values, recommendations, suggested_accas — at five rows for free and
-- anonymous readers, and everything since has been written as though that was
-- the paywall. It was the paywall on four tables. Measured against production
-- on 2 Aug 2026, what the `anon` role could actually read:
--
--     computed_values      10 rows   (9 matches)   ← capped by 034
--     value_signals         5 rows                 ← capped by 034
--     recommendations       5 rows                 ← capped by 034
--     suggested_accas       5 rows                 ← capped by 034
--     matches          49,351 rows   (9,570 still to be played)   ← USING (true)
--     odds             87,748 rows                                ← USING (true)
--     odds_snapshots  477,066 rows                                ← USING (true)
--     match_stats         270 rows                                ← USING (true)
--     inplay_market_series    all                                 ← USING (true)
--
-- So `/matches` handed anyone every fixture the engine covers at full season
-- depth, and one `GET /rest/v1/odds_snapshots?select=*` returned the complete
-- price history behind all of it. The frontend now caps every surface (see
-- FREE_PREVIEW in eve-frontend lib/portal/tiers.js), but a client-side cap is a
-- decision about what to DRAW, not about what to SEND. This migration makes the
-- database agree with the product.
--
-- FIX. Two bounded match sets, and every fixture-scoped table gates on one of
-- them:
--
--   preview_priced_match_ids()  the matches behind the rows 034 already lets
--                               through — 9 of them today. This is the set with
--                               INTELLIGENCE attached, so it is what the price
--                               tables are scoped to.
--
--   preview_match_ids()         the above, PLUS a bounded window of the soonest
--                               kickoffs and the most recent results, so the
--                               fixture board still has something to be. Used
--                               by `matches` and nothing else.
--
-- The priced set is not optional and must not be dropped from the wider set:
-- `computed_values` embeds `match:matches(...)`, so if a previewed signal's
-- parent match row is invisible the embed resolves to null and the free board
-- renders rows with no teams on them.
--
-- Measured effect on the anon role (same rolled-back check as above):
--
--     matches         49,351 → 40        odds       87,748 → 822
--     odds_snapshots 477,066 → 4,037     match_stats   270 → 0 (until a
--                                        previewed fixture goes live)
--
-- Paid tiers are untouched: every policy short-circuits on
-- `current_tier() <> 'free'` exactly as 034's do, so PAID ACCESS NEEDS NO
-- FRONTEND CHANGE. The engine is untouched too — it writes with the
-- service-role key, which bypasses RLS entirely.
--
-- WHAT IS DELIBERATELY LEFT OPEN:
--   • teams and leagues — reference data with no intelligence in them.
--     league_directory is a VIEW over `matches` and narrows with it; see the
--     note in the policy block for why that was left to narrow.
--   • performance_summary — the public record. §3.1's rule is that aggregates
--     stay real even inside the paywall, and "proof accruing in public" that
--     the public cannot read is not proof.

begin;

-- ── The knob: how deep the free fixture window goes ──────────────────────────
-- Sized above the frontend's own caps (8 upcoming / 3 live / 5 results) so the
-- client is filtering a window it was actually given, rather than showing an
-- empty rail whenever the next few kickoffs happen to be filtered out.
create or replace function public.free_fixture_limit()
returns integer language sql immutable
set search_path = public, pg_catalog as $$ select 20 $$;

-- ── The priced set: matches carrying preview intelligence ────────────────────
-- SECURITY DEFINER and owner-run for the same reason 034's helpers are: an
-- inline `id in (select … from matches limit N)` inside a policy ON matches is
-- a self-reference, and Postgres raises "infinite recursion detected in policy".
--
-- STABLE (not VOLATILE) matters for more than correctness: it lets the planner
-- hoist the call into an InitPlan and evaluate it ONCE per query rather than
-- once per row — the same concern migration 037 addressed for auth.uid(). On a
-- 477,000-row table that difference is the whole cost of this migration.
create or replace function public.preview_priced_match_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select distinct cv.match_id
    from public.computed_values cv
   where cv.match_id is not null
     and cv.id in (select public.preview_computed_value_ids())
  union
  select distinct vs.match_id
    from public.value_signals vs
   where vs.match_id is not null
     and vs.id in (select public.preview_value_signal_ids())
$$;

-- ── The fixture window: the priced set plus a browsable slice ────────────────
create or replace function public.preview_match_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select public.preview_priced_match_ids()
  union
  -- the soonest kickoffs — the fixture board's live and upcoming rails
  select id from (
    select id from public.matches
     where kickoff_at >= now()
     order by kickoff_at asc
     limit public.free_fixture_limit()
  ) upcoming
  union
  -- the most recent results — the fixture board's results rail
  select id from (
    select id from public.matches
     where kickoff_at < now()
       and goals_home is not null
     order by kickoff_at desc
     limit public.free_fixture_limit()
  ) played
$$;

-- match_stats keys on the API-Football fixture id (text), not our match uuid —
-- see components/LiveMatchStats.js, which resolves matches.external_id first.
-- A policy that subqueried public.matches directly would have that subquery
-- filtered by matches' OWN policy, which is a coupling that breaks quietly the
-- next time either policy moves. The translation gets its own owner-run helper.
create or replace function public.preview_fixture_external_ids()
returns setof text language sql stable security definer
set search_path = public, pg_catalog as $$
  select m.external_id
    from public.matches m
   where m.external_id is not null
     and m.id in (select public.preview_priced_match_ids())
$$;

revoke all on function
  public.free_fixture_limit(),
  public.preview_priced_match_ids(),
  public.preview_match_ids(),
  public.preview_fixture_external_ids()
from public;
grant execute on function
  public.free_fixture_limit(),
  public.preview_priced_match_ids(),
  public.preview_match_ids(),
  public.preview_fixture_external_ids()
to anon, authenticated;

-- ── matches ──────────────────────────────────────────────────────────────────
-- The big one: 49,351 rows, 9,570 of them still to be played, previously
-- readable in full by anyone holding the anon key.
drop policy if exists "public read matches" on public.matches;
create policy "tiered_read_matches" on public.matches
  for select to anon, authenticated
  using ( current_tier() <> 'free' or id in (select public.preview_match_ids()) );

-- ── odds ─────────────────────────────────────────────────────────────────────
-- Every bookmaker's quote on every fixture. The de-vigged consensus is built
-- from exactly this, so an open `odds` table is the raw material of the product
-- handed over with the margin still in it.
drop policy if exists "public read odds" on public.odds;
create policy "tiered_read_odds" on public.odds
  for select to anon, authenticated
  using ( current_tier() <> 'free' or match_id in (select public.preview_priced_match_ids()) );

-- ── odds_snapshots ───────────────────────────────────────────────────────────
-- The price journey — 477,066 rows of it. This is what the Prices tab and the
-- movers terminal ARE, and it is the evidence behind every CLV claim we make.
drop policy if exists "anon_read" on public.odds_snapshots;
create policy "tiered_read_odds_snapshots" on public.odds_snapshots
  for select to anon, authenticated
  using ( current_tier() <> 'free' or match_id in (select public.preview_priced_match_ids()) );

-- ── inplay_market_series ─────────────────────────────────────────────────────
-- The live market chart. In-play is the most perishable thing the product
-- sells, so it gets the same treatment as the pre-match price history.
drop policy if exists "ims_read_all" on public.inplay_market_series;
create policy "tiered_read_inplay_market_series" on public.inplay_market_series
  for select to anon, authenticated
  using ( current_tier() <> 'free' or match_id in (select public.preview_priced_match_ids()) );

-- ── match_stats ──────────────────────────────────────────────────────────────
drop policy if exists "public read match_stats" on public.match_stats;
create policy "tiered_read_match_stats" on public.match_stats
  for select to anon, authenticated
  using ( current_tier() <> 'free' or fixture_id in (select public.preview_fixture_external_ids()) );

-- ── league_directory: TRIED AND REVERTED, on purpose ────────────────────────
-- `league_directory` is `select … from matches m join leagues l … group by l.id`
-- carrying `security_invoker=true`, so it runs with the CALLER's row access and
-- bounding `matches` bounds it too: a free reader's directory holds the ~14
-- leagues their 40 preview fixtures belong to, not the 43 the engine covers.
--
-- This migration first set `security_invoker=false` so the catalogue stayed
-- whole — it holds only league ids, names, countries and fixture counts, which
-- is the same category as `teams` and `leagues`, both left open here. That was
-- reverted within the hour: Supabase's linter raises `security_definer_view`
-- at ERROR level for it, and a standing ERROR on a view that bypasses RLS is
-- the wrong thing to leave in the advisor list for whoever reads it next —
-- especially to serve a number.
--
-- So the catalogue narrows for free readers and the FRONTEND stops quoting it.
-- The fixture board's padlocked line read "Plus opens all {N} competitions" and
-- would have advertised 14; it now reads "every competition the engine covers".
-- Same rule the preview notes already follow: a total we cannot trust at this
-- tier is a total we do not state.

commit;

-- 047a — applied minutes later, as a correction. Both came from the Supabase
-- linter after 047 landed:
--
--   alter view public.league_directory set (security_invoker = true);
--   -- 047 had briefly set this to false; see the note above for why it went back.
--
--   create or replace function public.free_preview_limit()   -- 034's, unpinned since July
--   returns integer language sql immutable
--   set search_path = public, pg_catalog as $$ select 5 $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY. Run this before and after; it rolls itself back either way.
--
--   begin;
--   set local role anon;
--   select (select count(*) from matches)              as matches,
--          (select count(*) from odds)                 as odds,
--          (select count(*) from odds_snapshots)       as snapshots,
--          (select count(*) from match_stats)          as match_stats,
--          (select count(*) from inplay_market_series) as inplay_series,
--          (select count(*) from computed_values)      as computed_values;
--   rollback;
--
-- Expected after: matches 40, odds ~800, snapshots ~4,000, computed_values
-- UNCHANGED at 10 — this migration must not move 034's numbers.
--
-- Then check the free board still renders on maxedge.live with the admin tier
-- switcher set to Free, per blueprint §4.3. The one thing that cannot be
-- checked here is whether the embedded `match:matches(...)` joins still resolve
-- for a free reader; only a real deployment can settle that, and if they do not
-- the free board renders rows with no team names on them.
--
-- ALSO CHECK THE PLAN. On odds_snapshots the policy must appear as an InitPlan
-- (one evaluation), not a per-row filter:
--
--   begin;
--   set local role anon;
--   explain (analyze, buffers) select count(*) from odds_snapshots;
--   rollback;
--
-- ROLLBACK (restores the previous fully-open behaviour):
--
--   begin;
--   drop policy if exists "tiered_read_matches"              on public.matches;
--   drop policy if exists "tiered_read_odds"                 on public.odds;
--   drop policy if exists "tiered_read_odds_snapshots"       on public.odds_snapshots;
--   drop policy if exists "tiered_read_match_stats"          on public.match_stats;
--   drop policy if exists "tiered_read_inplay_market_series" on public.inplay_market_series;
--   create policy "public read matches"     on public.matches     for select to public using (true);
--   create policy "public read odds"        on public.odds        for select to public using (true);
--   create policy "anon_read"               on public.odds_snapshots for select to anon, authenticated using (true);
--   create policy "public read match_stats" on public.match_stats for select to public using (true);
--   create policy "ims_read_all"            on public.inplay_market_series for select to public using (true);
--   commit;
-- ─────────────────────────────────────────────────────────────────────────────
