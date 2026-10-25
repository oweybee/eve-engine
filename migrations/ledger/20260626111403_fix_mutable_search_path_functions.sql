-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111403, name fix_mutable_search_path_functions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


ALTER FUNCTION public.compute_performance_summary()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.trg_settle_on_match_complete()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.merge_duplicate_value_signal()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.upsert_value_signal(
  p_match_id uuid,
  p_outcome text,
  p_detected_odds numeric,
  p_detected_edge numeric,
  p_detected_mes integer,
  p_bookmaker text,
  p_kickoff_at timestamp with time zone
)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.capture_pre_kickoff_odds()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.settle_match_signals(p_match_id uuid)
  SET search_path = public, pg_catalog;

