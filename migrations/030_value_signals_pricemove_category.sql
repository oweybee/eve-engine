-- 030_value_signals_pricemove_category.sql
--
-- CRITICAL FIX: computeValues.js classifies a re-pricing event (an outcome
-- whose price has moved since the last snapshot) as signal_category = 'PriceMove'.
-- The CHECK constraint added in migration 019 only allowed
-- ('Prime', 'Longshot Edge', 'Standard'), so every batch INSERT containing a
-- PriceMove row failed with a constraint violation, which propagated to
-- process.exit(1) and crashed the engine run.
--
-- This widens the allowed set to include 'PriceMove'. 'Standard' remains the
-- safe DEFAULT so legacy rows and any code path that omits the field stay valid.
--
-- Idempotent: drops the existing constraint (if present) before re-adding.

ALTER TABLE value_signals
  DROP CONSTRAINT IF EXISTS value_signals_signal_category_check;

ALTER TABLE value_signals
  ADD CONSTRAINT value_signals_signal_category_check
  CHECK (signal_category IN ('Prime', 'Longshot Edge', 'Standard', 'PriceMove'));
