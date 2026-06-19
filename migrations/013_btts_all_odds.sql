-- Migration 013: Per-bookmaker BTTS odds maps on computed_values
ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS all_btts_yes_odds JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS all_btts_no_odds  JSONB DEFAULT NULL;
