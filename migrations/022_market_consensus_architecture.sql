-- Migration 022: Add MARKET_CONSENSUS to model_architecture CHECK constraint
--
-- computeValues.js v6 (Kaunitz et al. market consensus model) writes
-- model_architecture = 'MARKET_CONSENSUS'. The existing CHECK constraint
-- only allows the four ML/Dixon-Coles variants, so every upsert would fail
-- without this change.

ALTER TABLE computed_values
  DROP CONSTRAINT IF EXISTS computed_values_model_architecture_check;

ALTER TABLE computed_values
  ADD CONSTRAINT computed_values_model_architecture_check
  CHECK (model_architecture = ANY (ARRAY[
    'DIXON_COLES'::text,
    'ML_ENSEMBLE'::text,
    'XGBOOST_PREMATCH'::text,
    'SUPERMODEL_PREMATCH'::text,
    'MARKET_CONSENSUS'::text
  ]));
