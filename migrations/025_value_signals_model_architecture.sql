-- Migration 025: Add model_architecture to value_signals
-- Allows the frontend to distinguish MARKET_CONSENSUS vs API_PREDICTIVE signals.
-- NULL = legacy rows written before this migration (treated as MARKET_CONSENSUS).
ALTER TABLE value_signals
  ADD COLUMN IF NOT EXISTS model_architecture TEXT
  CHECK (model_architecture IS NULL OR model_architecture = ANY (ARRAY[
    'MARKET_CONSENSUS'::text,
    'API_PREDICTIVE'::text,
    'DIXON_COLES'::text,
    'ML_ENSEMBLE'::text,
    'XGBOOST_PREMATCH'::text,
    'SUPERMODEL_PREMATCH'::text
  ]));

CREATE INDEX IF NOT EXISTS value_signals_model_arch_idx
  ON value_signals (model_architecture);
