-- 035_db_housekeeping.sql
--
-- APPLIED to production 2026-07-06. Two zero-risk fixes from the Supabase
-- advisors (FULL_SITE_AUDIT Low / M-notes).

-- 1) Duplicate index: public.lineups had two identical UNIQUE constraints on
--    (fixture_id, team_id) — lineups_fixture_team_uq and uq_lineups_fixture_team.
--    Drop one; the other still enforces uniqueness. (Duplicate index = wasted
--    write overhead + storage.)
alter table public.lineups drop constraint if exists uq_lineups_fixture_team;

-- 2) Mutable search_path on a SECURITY-relevant trigger function. Pin it so the
--    function can't be influenced by a caller's search_path (advisor 0011).
alter function public.set_updated_at() set search_path = '';

-- NOT INCLUDED HERE (deliberately deferred — see FULL_SITE_AUDIT M16):
-- the auth_rls_initplan advisor recommends wrapping auth.uid() as
-- (select auth.uid()) in the RLS policies on bets/profiles/preferences/
-- subscriptions/bankroll_transactions/user_bookmakers for per-row eval savings.
-- That means recreating user-data isolation policies, so it should be done as a
-- reviewed change against those exact policy definitions — not bundled here.
