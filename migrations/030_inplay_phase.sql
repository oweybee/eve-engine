-- 030_inplay_phase.sql
-- =============================================================================
-- In-play signals: separate the pre-match and in-play pipelines at the data
-- layer so in-play picks never pollute the headline CLV / yield metric.
--
-- Background
-- ----------
-- value_signals had no pre-match / in-play discriminator. computeValues.js
-- selected matches WHERE status IN ('scheduled','live'), so any edge detected
-- after kickoff landed in the same table that performance_summary aggregates —
-- and CLV (ln(detected/closing)) is undefined in-play because the line already
-- closed at kickoff. This migration adds an explicit `phase` column and the
-- supporting metadata so the two pipelines are first-class and independently
-- measured.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP+ADD).
-- =============================================================================

-- 1. phase discriminator on value_signals -------------------------------------
ALTER TABLE value_signals
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'prematch'
    CHECK (phase IN ('prematch', 'inplay'));

-- Legacy rows were all pre-match by construction; the DEFAULT backfills them.
CREATE INDEX IF NOT EXISTS idx_vs_phase
  ON value_signals (phase, detected_at DESC);

-- 2. Reconcile signal_category with what the engine actually writes -----------
-- Migration 019 constrained signal_category to ('Prime','Longshot Edge',
-- 'Standard'), but computeValues.js has since written 'PriceMove'. Recreate the
-- constraint to match the code and admit the in-play category.
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_signal_category_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_signal_category_check
  CHECK (signal_category = ANY (ARRAY[
    'Prime'::text,
    'Longshot Edge'::text,
    'Standard'::text,
    'PriceMove'::text,
    'InPlay'::text
  ]));

-- 3. Register the in-play model architecture ----------------------------------
-- The half-time supermodel (models/supermodel_halftime_v2.onnx) is the engine
-- behind model-vs-market in-play value. Add it to the allowed set (preserving
-- every architecture migrations 025/028 already registered).
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
    'SUPERMODEL_HALFTIME'::text
  ]));

-- 4. Live match state on matches ----------------------------------------------
-- goals_home / goals_away already exist (fetchResults.js writes them at FT);
-- during play ingestLiveOdds.js keeps them current. `minute` is the elapsed
-- clock used by in-play features and the Telegram message.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS minute smallint;

-- 5. Per-phase performance_summary --------------------------------------------
-- performance_summary is a singleton keyed on singleton_key (migration 016).
-- Keep 'current' as the pre-match headline row and add a second 'inplay' row.
-- avg_clv stays NULL for the in-play row — CLV is meaningless after kickoff.
ALTER TABLE performance_summary
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'prematch'
    CHECK (phase IN ('prematch', 'inplay'));

COMMENT ON COLUMN value_signals.phase IS
  'prematch = detected before kickoff (CLV-tracked); inplay = detected during '
  'the live match (yield/strike-rate only, CLV undefined).';
COMMENT ON COLUMN performance_summary.phase IS
  'Which pipeline this summary row measures. singleton_key ''current'' = prematch, '
  '''inplay'' = in-play. Lets the frontend read both without conflating them.';
