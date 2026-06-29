-- Migration 028: register the secondary-market model architectures.
--
-- DIXON_COLES (goals O/U + BTTS) is already allowed by migration 025. Add the
-- data-driven corners and cards models so their signals pass the
-- model_architecture CHECK. Frontend MES trust-weights each accordingly.

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
    'SUPERMODEL_PREMATCH'::text
  ]));
