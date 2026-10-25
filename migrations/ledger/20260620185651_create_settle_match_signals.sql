-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620185651, name create_settle_match_signals. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Settlement function: called whenever a match result becomes known.
-- Closes out both value_signals and recommendations in one pass.
CREATE OR REPLACE FUNCTION settle_match_signals(p_match_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
BEGIN
  SELECT result INTO v_result FROM matches WHERE id = p_match_id;
  IF v_result IS NULL THEN RETURN; END IF;

  -- 1. Settle recommendations: join to closing odds snapshot where available
  UPDATE recommendations r
  SET
    closing_odds     = COALESCE(closing.odds, r.closing_odds),
    settled          = true,
    won              = (r.selection = v_result),
    clv_pct          = CASE
                         WHEN closing.odds IS NOT NULL AND closing.odds > 0
                         THEN ROUND((r.recommended_odds - closing.odds) / closing.odds * 100, 2)
                       END,
    pre_kickoff_odds = COALESCE(r.pre_kickoff_odds, closing.odds)
  FROM (
    SELECT DISTINCT ON (selection) selection, odds
    FROM odds_snapshots
    WHERE match_id = p_match_id AND snapshot_type = 'closing'
    ORDER BY selection, captured_at DESC
  ) closing
  WHERE r.match_id    = p_match_id
    AND r.settled     = false
    AND r.selection   = closing.selection;

  -- Catch any recommendations with no closing snapshot (set won but leave odds null)
  UPDATE recommendations
  SET settled = true,
      won     = (selection = v_result)
  WHERE match_id = p_match_id AND settled = false;

  -- 2. Settle value_signals: use standard CLV formula (detected - closing) / closing
  UPDATE value_signals vs
  SET
    closing_odds = COALESCE(closing.odds, vs.closing_odds),
    result       = CASE WHEN vs.outcome = v_result THEN 'win' ELSE 'loss' END,
    clv          = CASE
                     WHEN closing.odds IS NOT NULL AND closing.odds > 0
                     THEN ROUND((vs.detected_odds - closing.odds) / closing.odds, 4)
                   END
  FROM (
    SELECT DISTINCT ON (selection) selection, odds
    FROM odds_snapshots
    WHERE match_id = p_match_id AND snapshot_type = 'closing'
    ORDER BY selection, captured_at DESC
  ) closing
  WHERE vs.match_id = p_match_id
    AND vs.result   = 'pending'
    AND vs.outcome  = closing.selection;

  -- Settle value_signals with no closing snapshot (result only, leave CLV null)
  UPDATE value_signals
  SET result = CASE WHEN outcome = v_result THEN 'win' ELSE 'loss' END
  WHERE match_id = p_match_id AND result = 'pending';
END;
$$;

-- Trigger function: fires on matches UPDATE when status → completed
CREATE OR REPLACE FUNCTION trg_settle_on_match_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed'
    AND (OLD.status IS DISTINCT FROM 'completed')
    AND NEW.result IS NOT NULL
  THEN
    PERFORM settle_match_signals(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_match_complete_settle ON matches;
CREATE TRIGGER trg_match_complete_settle
  AFTER UPDATE ON matches
  FOR EACH ROW
  EXECUTE FUNCTION trg_settle_on_match_complete();

