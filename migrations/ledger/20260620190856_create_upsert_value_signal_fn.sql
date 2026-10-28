-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620190856, name create_upsert_value_signal_fn. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Clean upsert entry-point for the ingestion job.
-- Call this instead of a plain INSERT — preserves original detection price,
-- increments the persistence counter, and hard-blocks post-kickoff signals.
-- Usage: SELECT upsert_value_signal($match_id, $outcome, $detected_odds, ...)
CREATE OR REPLACE FUNCTION upsert_value_signal(
  p_match_id      uuid,
  p_outcome       text,
  p_detected_odds numeric,
  p_detected_edge numeric  DEFAULT NULL,
  p_detected_mes  integer  DEFAULT NULL,
  p_bookmaker     text     DEFAULT NULL,
  p_kickoff_at    timestamptz DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Block signals after kickoff
  IF p_kickoff_at IS NOT NULL AND now() > p_kickoff_at THEN
    RETURN;
  END IF;

  INSERT INTO value_signals (
    match_id, outcome, detected_odds, detected_edge,
    detected_mes, bookmaker, kickoff_at, detected_at
  )
  VALUES (
    p_match_id, p_outcome, p_detected_odds, p_detected_edge,
    p_detected_mes, p_bookmaker, p_kickoff_at, now()
  )
  ON CONFLICT (match_id, outcome) DO UPDATE
    SET detection_count = value_signals.detection_count + 1,
        last_seen_at    = now()
    -- detected_odds / detected_at / bookmaker intentionally NOT overwritten:
    -- we keep the original price the signal was first advertised at.
  ;
END;
$$;

