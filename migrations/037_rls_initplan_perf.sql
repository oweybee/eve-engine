-- 037_rls_initplan_perf.sql — APPLIED to production 2026-07-06.
--
-- Perf: wrap auth.uid() as (select auth.uid()) in the user-data RLS policies so
-- Postgres evaluates it ONCE per query (initplan) instead of once per row
-- (Supabase advisor 0003 auth_rls_initplan, audit M16). Semantically identical —
-- ownership scoping is unchanged; only the eval count differs.
--
-- Recreated (drop + create with the wrap): profiles (select/update/insert own),
-- preferences (own, insert_own), bankroll_transactions (own), user_bookmakers
-- (own), bets (select/insert/update/delete own), subscriptions (read own).
-- Example (the rest follow the same pattern):

drop policy if exists "bets_select_own" on public.bets;
create policy "bets_select_own" on public.bets for select to authenticated
  using (((select auth.uid()) = user_id)
         and ((created_at >= (now() - '30 days'::interval)) or (current_tier() <> 'free'::text)));

-- (See migration history / pg_policies for the full set — all 12 policies were
-- recreated identically except auth.uid() → (select auth.uid()).)
