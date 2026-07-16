-- 038_second_half_sniper.sql
-- =============================================================================
-- Register the SECOND_HALF_SNIPER in-play model architecture.
--
-- The Second Half Sniper (lib/secondHalfSniper.js) fires a single Over-goals
-- entry at the half-time break on a hot (low-scoring) scoreline, holding the
-- frozen pre-match goal expectation (inplay_baseline λ) against the live Over
-- price. Its signals are phase='inplay', market='totals', outcome='over'.
--
-- Add it to the model_architecture CHECK, preserving every architecture the
-- prior migrations (025 / 028 / 030 / 032) already registered. Idempotent.
-- =============================================================================

ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_model_architecture_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_model_architecture_check
  CHECK (model_architecture IS NULL OR model_architecture = ANY (ARRAY[
    'MARKET_CONSENSUS'::text,
    'API_PREDICTIVE'::text,
    'DIXON_COLES'::text,
    'CORNERS_MODEL'::text,
    'CARDS_MODEL'::text,
    'ML_ENSEMBLE'::text,
    'XGBOOST_PREMATCH'::text,
    'SUPERMODEL_PREMATCH'::text,
    'SUPERMODEL_HALFTIME'::text,
    'INPLAY_DIXON_COLES'::text,
    'SECOND_HALF_SNIPER'::text
  ]));
