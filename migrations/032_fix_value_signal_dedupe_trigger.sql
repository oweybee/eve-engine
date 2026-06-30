-- 032_fix_value_signal_dedupe_trigger.sql
--
-- Fixes "no new signals" — the live ledger freezing once a slate is seen.
--
-- A BEFORE INSERT trigger, merge_duplicate_value_signal(), de-dupes incoming
-- value_signals: if a matching row already exists it bumps detection_count /
-- last_seen_at on that row and RETURN NULLs (silently skipping the INSERT),
-- otherwise it lets the row through. This is why computeValues logs
-- "[value_signals] inserted N" yet the table never grows and no error surfaces.
--
-- BUG: the trigger keyed duplicates on (match_id, outcome) ONLY. But `outcome`
-- is NOT unique within a match across markets/models — it collides:
--   * over / under   -> totals (DIXON_COLES) AND corners (CORNERS_MODEL)
--                       AND bookings (CARDS_MODEL)
--   * home/draw/away -> MARKET_CONSENSUS AND API_PREDICTIVE
-- So a genuinely-distinct signal (e.g. corners "over") was merged into an
-- existing totals "over" and dropped. Once every (match, outcome) label on the
-- upcoming slate had been seen once, EVERY further detection — including all
-- distinct markets/models that share that label — was suppressed, and the feed
-- went quiet ("no signals in 14 hours").
--
-- FIX: key the de-dupe on the SAME tuple the table's real uniqueness uses,
-- value_signals_match_market_outcome_arch_unique (migration 026):
--   (match_id, COALESCE(market,'h2h'), outcome, COALESCE(model_architecture,'MARKET_CONSENSUS'))
-- Distinct market/model selections now insert as their own ledger rows; only a
-- true repeat of the exact same selection is merged (detection_count bumped).
--
-- This trigger, its function, and the detection_count / last_seen_at columns
-- were originally created out-of-band (not via a committed migration); this file
-- brings them under version control idempotently so the schema is reproducible.

-- 1. Columns the de-dupe trigger maintains (no-ops if already present) ----------
ALTER TABLE value_signals
  ADD COLUMN IF NOT EXISTS detection_count integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at    timestamptz NOT NULL DEFAULT now();

-- 2. Corrected de-dupe function ------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_duplicate_value_signal()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Hard block: never accept a signal detected after the match has kicked off.
  IF NEW.kickoff_at IS NOT NULL AND NEW.detected_at > NEW.kickoff_at THEN
    RETURN NULL;
  END IF;

  -- De-dupe on the full selection identity (match, market, outcome, model) so
  -- distinct markets/models that share an `outcome` label do NOT collide.
  IF EXISTS (
    SELECT 1 FROM value_signals
    WHERE match_id = NEW.match_id
      AND outcome  = NEW.outcome
      AND COALESCE(market, 'h2h') = COALESCE(NEW.market, 'h2h')
      AND COALESCE(model_architecture, 'MARKET_CONSENSUS')
        = COALESCE(NEW.model_architecture, 'MARKET_CONSENSUS')
  ) THEN
    UPDATE value_signals
    SET
      closing_odds    = COALESCE(NEW.closing_odds, closing_odds),
      clv             = COALESCE(NEW.clv, clv),
      result          = CASE WHEN NEW.result IS DISTINCT FROM 'pending'
                             THEN NEW.result ELSE result END,
      kickoff_at      = COALESCE(NEW.kickoff_at, kickoff_at),
      detection_count = detection_count + 1,
      last_seen_at    = now()
    WHERE match_id = NEW.match_id
      AND outcome  = NEW.outcome
      AND COALESCE(market, 'h2h') = COALESCE(NEW.market, 'h2h')
      AND COALESCE(model_architecture, 'MARKET_CONSENSUS')
        = COALESCE(NEW.model_architecture, 'MARKET_CONSENSUS');
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Trigger (idempotent re-create so the binding lives in the repo) -----------
DROP TRIGGER IF EXISTS trg_dedupe_value_signals ON value_signals;
CREATE TRIGGER trg_dedupe_value_signals
  BEFORE INSERT ON value_signals
  FOR EACH ROW
  EXECUTE FUNCTION merge_duplicate_value_signal();
