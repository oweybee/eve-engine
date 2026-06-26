-- Migration 024: Replace single-column UNIQUE(match_id) with composite
-- UNIQUE(match_id, model_architecture) on computed_values.
--
-- Allows MARKET_CONSENSUS (Kaunitz) and API_PREDICTIVE engines to each
-- maintain an independent row per match without overwriting each other.
-- Both engines use onConflict: 'match_id,model_architecture' after this.

ALTER TABLE computed_values DROP CONSTRAINT IF EXISTS cv_match_unique;

ALTER TABLE computed_values
  ADD CONSTRAINT cv_match_model_unique UNIQUE (match_id, model_architecture);
