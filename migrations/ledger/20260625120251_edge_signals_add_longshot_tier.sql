-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625120251, name edge_signals_add_longshot_tier. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

ALTER TABLE edge_signals
  DROP CONSTRAINT IF EXISTS edge_signals_tier_check;

ALTER TABLE edge_signals
  ADD CONSTRAINT edge_signals_tier_check
    CHECK (tier IN ('RUBY', 'VALUE', 'LONGSHOT'));
