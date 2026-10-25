-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260622161925, name 018_computed_values_signals_written. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Migration 018: signals_written checkpoint column on computed_values
-- Fixes P2-5: upsertComputedValues can succeed while insertValueSignals crashes,
-- leaving the signals gap permanently undetected on re-runs.
-- signals_written = false → insertValueSignals has not yet succeeded for this row
-- signals_written = true  → signals are committed; skip on any subsequent run

ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS signals_written boolean NOT NULL DEFAULT false;

-- Partial index supports the fast "find all unprocessed rows" lookup pattern
-- used in run() after each bulk upsert.
CREATE INDEX IF NOT EXISTS idx_cv_signals_unprocessed
  ON computed_values (match_id)
  WHERE signals_written = false;

COMMENT ON COLUMN computed_values.signals_written IS
  'True once insertValueSignals has committed for this row. '
  'Prevents duplicate signal emission on crash-and-retry runs. '
  'Reset to false only by clearing the row or a manual admin operation.';
