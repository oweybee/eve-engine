-- 033_value_signal_price_move_realerts.sql
--
-- Enable price-move re-alerts on the value_signals ledger.
--
-- Background: the de-dupe trigger merge_duplicate_value_signal() (see migration
-- 032) collapsed EVERY re-detection of a selection into a single row — it only
-- ever bumped detection_count/last_seen_at and never created a new row or moved
-- detected_at. Combined with the one-row-per-selection unique index from
-- migration 026, that froze the "live ledger": once a selection was seen, its
-- price could drift all day and nothing new ever surfaced.
--
-- This restores the engine's documented v7 intent ("different price = new
-- signal"): a meaningful price move is recorded as its own timestamped ledger
-- row, while same-price repeats are still de-duped (the engine also guards
-- same-price within SIGNAL_DEDUP_MINUTES in computeValues, so the trigger is the
-- backstop, not the only gate).
--
-- Two coordinated changes:
--   1. The unique index can no longer be "one row per (match, market, outcome,
--      model) forever" — that blocks the second price point. Re-key it to also
--      include detected_odds, so distinct prices coexist but an exact
--      (selection, price) duplicate still cannot.
--   2. The trigger inserts when the price has moved vs the most recent row for
--      the selection, and merges (bumps counters) when it has not.

-- 1. Allow multiple price points per selection ---------------------------------
DROP INDEX IF EXISTS value_signals_match_market_outcome_arch_unique;

CREATE UNIQUE INDEX IF NOT EXISTS value_signals_selection_price_unique
  ON value_signals (
    match_id,
    COALESCE(market, 'h2h'),
    outcome,
    COALESCE(model_architecture, 'MARKET_CONSENSUS'),
    detected_odds
  );

-- 2. Price-aware de-dupe trigger ----------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_duplicate_value_signal()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_last_id   uuid;
  v_last_odds numeric;
BEGIN
  -- Hard block: never accept a signal detected after the match has kicked off.
  IF NEW.kickoff_at IS NOT NULL AND NEW.detected_at > NEW.kickoff_at THEN
    RETURN NULL;
  END IF;

  -- Most recent existing alert for this exact selection (match, market,
  -- outcome, model) — the price we compare the incoming alert against.
  SELECT id, detected_odds
    INTO v_last_id, v_last_odds
  FROM value_signals
  WHERE match_id = NEW.match_id
    AND outcome  = NEW.outcome
    AND COALESCE(market, 'h2h') = COALESCE(NEW.market, 'h2h')
    AND COALESCE(model_architecture, 'MARKET_CONSENSUS')
      = COALESCE(NEW.model_architecture, 'MARKET_CONSENSUS')
  ORDER BY detected_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Same price as the most recent alert → de-dupe (bump counters, no new row).
    -- A meaningful price move falls through and is recorded as a new row.
    IF v_last_odds IS NOT DISTINCT FROM NEW.detected_odds
       OR (v_last_odds IS NOT NULL AND NEW.detected_odds IS NOT NULL
           AND abs(v_last_odds - NEW.detected_odds) < 0.001) THEN
      UPDATE value_signals
      SET detection_count = detection_count + 1,
          last_seen_at    = now(),
          closing_odds    = COALESCE(NEW.closing_odds, closing_odds),
          clv             = COALESCE(NEW.clv, clv),
          result          = CASE WHEN NEW.result IS DISTINCT FROM 'pending'
                                 THEN NEW.result ELSE result END,
          kickoff_at      = COALESCE(NEW.kickoff_at, kickoff_at)
      WHERE id = v_last_id;
      RETURN NULL;
    END IF;
  END IF;

  -- New selection, or the price has moved → record a fresh ledger row.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_dedupe_value_signals ON value_signals;
CREATE TRIGGER trg_dedupe_value_signals
  BEFORE INSERT ON value_signals
  FOR EACH ROW
  EXECUTE FUNCTION merge_duplicate_value_signal();
