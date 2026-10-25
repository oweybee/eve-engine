-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260630173820, name performance_summary_clv_segments. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


ALTER TABLE performance_summary
  ADD COLUMN IF NOT EXISTS avg_clv_sweetspot        numeric,
  ADD COLUMN IF NOT EXISTS avg_no_vig_clv_sweetspot numeric,
  ADD COLUMN IF NOT EXISTS clv_sample               integer,
  ADD COLUMN IF NOT EXISTS clv_sweetspot_sample     integer;

