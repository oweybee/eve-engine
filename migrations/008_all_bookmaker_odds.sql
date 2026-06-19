-- Migration 008: per-outcome bookmaker odds maps
-- Adds JSONB columns to computed_values storing odds from every soft book,
-- keyed by bookmaker name. Used by the betslip intersection engine to find
-- the single bookmaker that covers all accumulator legs.
--
-- Shape: { "Sky Bet": 2.10, "William Hill": 2.05, "Paddy Power": 2.00, ... }

ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS all_home_odds JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS all_draw_odds JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS all_away_odds JSONB DEFAULT NULL;

COMMENT ON COLUMN computed_values.all_home_odds IS 'Map of bookmaker → home odds for every soft book offering this match';
COMMENT ON COLUMN computed_values.all_draw_odds IS 'Map of bookmaker → draw odds for every soft book offering this match';
COMMENT ON COLUMN computed_values.all_away_odds IS 'Map of bookmaker → away odds for every soft book offering this match';
