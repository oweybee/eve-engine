-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620193620, name fix_clv_formula_to_log_in_settle_fn. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Update settle_match_signals to use the same ln() formula the app displays
CREATE OR REPLACE FUNCTION settle_match_signals(p_match_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_result text;
BEGIN
  SELECT result INTO v_result FROM matches WHERE id = p_match_id;
  IF v_result IS NULL THEN RETURN; END IF;

  UPDATE recommendations r
  SET
    closing_odds     = COALESCE(closing.odds, r.closing_odds),
    settled          = true,
    won              = (r.selection = v_result),
    clv_pct          = CASE
                         WHEN closing.odds IS NOT NULL AND closing.odds > 0
                              AND r.recommended_odds IS NOT NULL AND r.recommended_odds > 0
                         THEN ROUND(LN(r.recommended_odds / closing.odds) * 100, 2)
                       END,
    pre_kickoff_odds = COALESCE(r.pre_kickoff_odds, closing.odds)
  FROM (
    SELECT DISTINCT ON (selection) selection, odds
    FROM odds_snapshots
    WHERE match_id = p_match_id AND snapshot_type = 'closing'
    ORDER BY selection, captured_at DESC
  ) closing
  WHERE r.match_id  = p_match_id
    AND r.settled   = false
    AND r.selection = closing.selection;

  UPDATE recommendations
  SET settled = true, won = (selection = v_result)
  WHERE match_id = p_match_id AND settled = false;

  -- value_signals: ln(detected / closing) * 100
  UPDATE value_signals vs
  SET
    closing_odds = COALESCE(closing.odds, vs.closing_odds),
    result       = CASE WHEN vs.outcome = v_result THEN 'win' ELSE 'loss' END,
    clv          = CASE
                     WHEN closing.odds IS NOT NULL AND closing.odds > 0
                          AND vs.detected_odds IS NOT NULL AND vs.detected_odds > 0
                     THEN ROUND(LN(vs.detected_odds / closing.odds) * 100, 2)
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

  UPDATE value_signals
  SET result = CASE WHEN outcome = v_result THEN 'win' ELSE 'loss' END
  WHERE match_id = p_match_id AND result = 'pending';
END;
$$;

