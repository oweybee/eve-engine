-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016160156, name predictor_league_grants. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

revoke all on public.predictor_scored from anon, authenticated;
revoke all on function public.predictor_leaderboard(int) from public, anon, authenticated;
revoke all on function public.predictor_open_round() from public, anon, authenticated;
revoke all on function public.predictor_round_fixtures(int) from public, anon, authenticated;
grant execute on function public.predictor_leaderboard(int) to service_role;
grant execute on function public.predictor_open_round() to service_role;
grant execute on function public.predictor_round_fixtures(int) to service_role;
