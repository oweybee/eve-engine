-- 039_match_results_rls.sql
--
-- ⚠️  STAGED FOR REVIEW — NOT YET APPLIED TO PRODUCTION.  ⚠️
--     Apply with the Supabase SQL editor / CLI once you're happy with the
--     approach below. See SECURITY_AUDIT_REPORT.md, Finding 1 & 2.
--
-- PROBLEM (Critical): public.match_results (77k+ rows of historical match
-- results used for ML training/backfill) has RLS disabled. The default
-- Supabase grants give anon/authenticated full SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE on it, so anyone holding the public anon key can read the entire
-- table via `GET /rest/v1/match_results?select=*`, or corrupt/wipe it via
-- INSERT/UPDATE/DELETE/TRUNCATE with no login required. The table is not
-- referenced by any application code — it is not consumed client-side.
--
-- FIX: enable RLS with no policies, matching the "service-role only" pattern
-- already used for other internal-only tables. service_role (used by the
-- engine/backfill scripts) bypasses RLS entirely, so this only removes
-- anon/authenticated access — nothing in the app currently reads or writes
-- this table via those roles. If a future feature needs client-side reads,
-- add an explicit `select` policy at that time.

begin;

alter table public.match_results enable row level security;

-- PROBLEM (Low): public.free_preview_limit() (added in 034) omitted the
-- search_path pin that its sibling SECURITY DEFINER helpers in the same
-- migration received, inconsistent with the hardening called out in
-- 035_db_housekeeping.sql (advisor 0011_function_search_path_mutable).
-- Low impact (no table access in the function body); fixed here for
-- consistency.
alter function public.free_preview_limit() set search_path = '';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (if you need to revert):
--
--   begin;
--   alter table public.match_results disable row level security;
--   alter function public.free_preview_limit() set search_path = pg_catalog, public;
--   commit;
-- ─────────────────────────────────────────────────────────────────────────────
