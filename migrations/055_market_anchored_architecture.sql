-- 055_market_anchored_architecture.sql
--
-- Admit 'MARKET_ANCHORED' to the model_architecture CHECK constraints on
-- computed_values and value_signals.
--
-- WHY THIS EXISTS, AND WHY IT IS THE SECOND TIME. Migration 054 and the
-- market-anchored rewrite of computeValues.js renamed the pre-match
-- architecture from MARKET_CONSENSUS to MARKET_ANCHORED, because a row priced
-- against Shin-de-vigged Pinnacle must not inherit the consensus's measured
-- verdict in either direction. The rename shipped. The CHECK constraint did
-- not, so every write was rejected:
--
--   [engine] fatal: upsertComputedValues: new row for relation
--   "computed_values" violates check constraint
--   "computed_values_model_architecture_check"
--
-- This is EXACTLY the failure CLAUDE.md records against `profiles_tier_check`:
-- the collapse to two tiers never reached the database, so the `tier='plus'`
-- the Stripe webhook wrote was rejected on every upgrade and nobody who paid
-- received the product. Same shape, different column — a rename in code, an
-- enumeration in the schema, and no test that crosses the gap.
--
-- One thing worked, and it is the thing that was fixed after the Stripe
-- incident: `upsertComputedValues` CHECKS its await and throws, so the engine
-- run failed loudly at 12:27 UTC instead of logging success over a write that
-- never happened. The board went stale rather than silently wrong. Keep every
-- write on this path checked.
--
-- LATENT BUG FOUND WHILE HERE, NOT FIXED HERE. `value_signals` admits
-- ML_ENSEMBLE, XGBOOST_PREMATCH and SUPERMODEL_PREMATCH but NOT 'SUPERMODEL',
-- which is the string the deleted supermodel publisher actually wrote. Any
-- signal it produced would have been rejected the same way. That publisher is
-- gone as of 6 Aug 2026 so the path is dead, and adding a name for a writer
-- that no longer exists would be worse than leaving it. Noted so the next
-- person does not rediscover it as a mystery.
--
-- MARKET_CONSENSUS is DELIBERATELY LEFT IN BOTH LISTS. Historic rows carry it
-- and they must keep validating; a constraint is checked on write, but a
-- narrower one turns any future backfill or restore of those rows into a
-- failure. The architecture is retired at the writer, not in the schema.

alter table computed_values
  drop constraint if exists computed_values_model_architecture_check;

alter table computed_values
  add constraint computed_values_model_architecture_check
  check (model_architecture = any (array[
    'MARKET_ANCHORED',      -- the current pre-match writer (Shin-de-vigged Pinnacle)
    'MARKET_CONSENSUS',     -- retired 6 Aug 2026; historic rows must still validate
    'DIXON_COLES',
    'API_PREDICTIVE',
    'ML_ENSEMBLE',
    'XGBOOST_PREMATCH',
    'SUPERMODEL_PREMATCH'
  ]));

alter table value_signals
  drop constraint if exists value_signals_model_architecture_check;

alter table value_signals
  add constraint value_signals_model_architecture_check
  check (model_architecture is null or model_architecture = any (array[
    'MARKET_ANCHORED',
    'MARKET_CONSENSUS',
    'DIXON_COLES',
    'API_PREDICTIVE',
    'CORNERS_MODEL',
    'CARDS_MODEL',
    'LAMBDA_MC',
    'ML_ENSEMBLE',
    'XGBOOST_PREMATCH',
    'SUPERMODEL_PREMATCH'
  ]));
