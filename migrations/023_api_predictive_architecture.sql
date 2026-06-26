-- Migration 023: Add API_PREDICTIVE to model_architecture CHECK constraint
--
-- computeApiPredictive.js writes model_architecture = 'API_PREDICTIVE'.
-- Expand the existing constraint to accept the new designation.

ALTER TABLE computed_values
  DROP CONSTRAINT IF EXISTS computed_values_model_architecture_check;

ALTER TABLE computed_values
  ADD CONSTRAINT computed_values_model_architecture_check
  CHECK (model_architecture = ANY (ARRAY[
    'DIXON_COLES'::text,
    'ML_ENSEMBLE'::text,
    'XGBOOST_PREMATCH'::text,
    'SUPERMODEL_PREMATCH'::text,
    'MARKET_CONSENSUS'::text,
    'API_PREDICTIVE'::text
  ]));
