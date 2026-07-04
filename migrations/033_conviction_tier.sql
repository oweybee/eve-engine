-- 033_conviction_tier.sql
--
-- Unify the tier vocabulary onto the single canonical conviction ladder
-- (lib/signalTier.js): signal_category now holds Prime | Value | Longshot, and
-- a price-move is carried by a new orthogonal is_mover boolean rather than the
-- old 'PriceMove' category. The prob-based 'Longshot Edge'/'Standard' split and
-- the 'InPlay' marker (redundant with the phase column) are folded away.
--
-- EXPAND + BACKFILL only. The old values stay allowed by the CHECK so a
-- mid-deploy engine/frontend can still read/write them; a later migration
-- CONTRACTS the CHECK to the three canonical values once every deploy has
-- shipped.

-- 1. Orthogonal price-move flag (replaces the 'PriceMove' category value).
ALTER TABLE value_signals
  ADD COLUMN IF NOT EXISTS is_mover boolean NOT NULL DEFAULT false;

-- 2. Expand the category CHECK to allow the new ladder alongside the legacy set.
ALTER TABLE value_signals
  DROP CONSTRAINT IF EXISTS value_signals_signal_category_check;
ALTER TABLE value_signals
  ADD CONSTRAINT value_signals_signal_category_check
  CHECK (signal_category = ANY (ARRAY[
    -- canonical conviction ladder
    'Prime'::text, 'Value'::text, 'Longshot'::text,
    -- legacy values (removed in a later contract migration)
    'Longshot Edge'::text, 'Standard'::text, 'PriceMove'::text, 'InPlay'::text
  ]));

-- 3a. Carry the old PriceMove meaning onto the new flag before recomputing.
UPDATE value_signals SET is_mover = true WHERE signal_category = 'PriceMove';

-- 3b. Recompute signal_category as the canonical odds+edge conviction tier.
--     Mirrors classifyTier() EXACTLY, including its ordering: the <2% edge
--     visibility floor is evaluated before the longshot odds band, so a
--     sub-floor long-odds row maps to Value, not Longshot.
UPDATE value_signals SET signal_category = CASE
  WHEN detected_edge IS NULL OR detected_odds IS NULL OR detected_edge < 0.02
    THEN 'Value'
  WHEN detected_odds >= 1.40 AND detected_odds < 3.00
       AND detected_edge >= 0.04 AND detected_edge < 0.10
    THEN 'Prime'
  WHEN detected_odds >= 3.00
    THEN 'Longshot'
  ELSE 'Value'
END;
