-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620185638, name add_value_signals_tracking_cols. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


ALTER TABLE value_signals
  ADD COLUMN detection_count  integer     NOT NULL DEFAULT 1,
  ADD COLUMN last_seen_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN odds_drift_pct   numeric     GENERATED ALWAYS AS (
    CASE
      WHEN closing_odds IS NOT NULL AND detected_odds IS NOT NULL AND detected_odds > 0
      THEN ROUND((closing_odds - detected_odds) / detected_odds, 4)
    END
  ) STORED,
  ADD COLUMN is_volatile      boolean     GENERATED ALWAYS AS (
    CASE
      WHEN closing_odds IS NOT NULL AND detected_odds IS NOT NULL AND detected_odds > 0
      THEN ABS((closing_odds - detected_odds) / detected_odds) > 0.15
    END
  ) STORED;

