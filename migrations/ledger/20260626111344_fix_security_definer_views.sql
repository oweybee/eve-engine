-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111344, name fix_security_definer_views. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


ALTER VIEW public.promotable_value_signals SET (security_invoker = true);
ALTER VIEW public.bet_of_day_candidates    SET (security_invoker = true);
ALTER VIEW public.matches_missing_ppda     SET (security_invoker = true);

