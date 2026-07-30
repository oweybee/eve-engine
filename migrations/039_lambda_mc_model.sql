-- 039: register the λ Monte Carlo goals-model (LAMBDA_MC) as a value-signal
-- source for the "model vs market" board.
--
-- LAMBDA_MC = market-anchored expected-goals model (Elo + form + proxy-xG +
-- squad value) exported to ONNX by ensemble/train_lambda_prod.py, priced through
-- the Dixon-Coles sheet (lib/dixonColes.js) by computeModelBoard.js. Signals
-- carry model_prob/market_prob/credible_score so the frontend board can render
-- the disagreement and its evidence-based ranking directly.

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
    'LAMBDA_MC'::text
  ]));

-- Board display columns (nullable; only LAMBDA_MC populates them).
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS model_prob     numeric(6,4);
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS market_prob    numeric(6,4);
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS credible_score numeric(7,4);
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS league_tag     text
  CHECK (league_tag IS NULL OR league_tag IN ('proven','neutral','avoid'));
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS price_seg      text
  CHECK (price_seg IS NULL OR price_seg IN ('fav','mid','longshot'));

CREATE INDEX IF NOT EXISTS idx_vs_lambda_board
  ON value_signals (detected_at DESC)
  WHERE model_architecture = 'LAMBDA_MC';
