-- Migration 026: multi-market value_signals
--
-- value_signals could only carry 1X2 picks: outcome was CHECK-constrained to
-- home/draw/away and the dedup key was UNIQUE (match_id, outcome). To publish
-- Over/Under, BTTS, cards and corners signals we need to (a) record which market
-- and line a pick belongs to, (b) allow the new outcome values, and (c) widen
-- the dedup key so an over/under on goals, corners and cards don't collide.
--
-- Fully backward-compatible: existing rows (all 1X2) backfill to market='h2h',
-- and the current engine — which doesn't set `market` — keeps working because
-- the column defaults to 'h2h' and the unique index COALESCEs NULL to 'h2h'.

ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS market      TEXT;
ALTER TABLE value_signals ADD COLUMN IF NOT EXISTS market_line NUMERIC;

-- Backfill legacy rows, then default new ones to the 1X2 market.
UPDATE value_signals SET market = 'h2h' WHERE market IS NULL;
ALTER TABLE value_signals ALTER COLUMN market SET DEFAULT 'h2h';

-- Constrain the market vocabulary.
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_market_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_market_check
  CHECK (market IS NULL OR market = ANY (ARRAY[
    'h2h'::text, 'totals'::text, 'btts'::text, 'bookings'::text, 'corners'::text
  ]));

-- Relax the outcome vocabulary to cover the secondary markets.
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_outcome_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_outcome_check
  CHECK (outcome = ANY (ARRAY[
    'home'::text, 'draw'::text, 'away'::text,
    'over'::text, 'under'::text,
    'btts_yes'::text, 'btts_no'::text
  ]));

-- Widen the dedup key: one signal per (match, market, outcome, model). This lets
-- over/under coexist across goals/corners/cards and lets two models independently
-- signal the same selection. COALESCE keeps legacy NULLs collapsing to the
-- historical (match_id, outcome) behaviour.
-- The old key is a UNIQUE constraint (which owns its index), so drop the
-- constraint; the bare DROP INDEX is a fallback for environments where it isn't.
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_match_outcome_unique;
DROP INDEX IF EXISTS value_signals_match_outcome_unique;
CREATE UNIQUE INDEX IF NOT EXISTS value_signals_match_market_outcome_arch_unique
  ON value_signals (
    match_id,
    COALESCE(market, 'h2h'),
    outcome,
    COALESCE(model_architecture, 'MARKET_CONSENSUS')
  );

CREATE INDEX IF NOT EXISTS idx_vs_market ON value_signals (market);
