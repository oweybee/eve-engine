-- 039_match_results_rls.sql
-- =============================================================================
-- SECURITY FIX (Critical): public.match_results was created directly against
-- the database (Supabase migration `20260716135233 create_match_results`) with
-- no corresponding file in this repo, and — unlike every other table in the
-- public schema — never had row level security enabled.
--
-- Supabase grants anon/authenticated broad table-level privileges
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) by default on every table in the
-- public schema; RLS is the enforcement layer that narrows those grants down
-- to what a policy allows. Every other table in this schema has RLS enabled
-- (see `public read matches`/`anon_read` for the read-only pattern used on
-- comparable fixture/reference tables: matches, teams, leagues, odds_snapshots,
-- team_statistics, referee_stats). match_results was the one exception: RLS
-- disabled entirely, so the default grants applied unfiltered — anyone with
-- just the publishable anon key could SELECT, INSERT, UPDATE, DELETE, or even
-- TRUNCATE all 77k+ rows of historical results (1993–present) via
-- `/rest/v1/match_results`, no auth required.
--
-- FIX: enable RLS and restore the same public-read-only shape used everywhere
-- else in the schema. Writes are performed exclusively by backfill/ingest
-- scripts using the service-role key, which bypasses RLS entirely (same as
-- every other fixture table here) — no explicit write policy is needed or
-- added, matching the existing convention in this codebase.
-- =============================================================================

alter table public.match_results enable row level security;

create policy "public read match_results" on public.match_results
  for select
  to public
  using (true);
