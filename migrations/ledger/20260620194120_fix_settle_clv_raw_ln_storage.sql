-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620194120, name fix_settle_clv_raw_ln_storage. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


CREATE OR REPLACE FUNCTION settle_match_signals(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_match record;
BEGIN
  -- Load match result
  SELECT status, home_score, away_score INTO v_match
  FROM matches WHERE id = p_match_id;

  IF v_match.status != 'completed' THEN
    RAISE EXCEPTION 'Match % is not completed (status: %)', p_match_id, v_match.status;
  END IF;

  -- Settle value_signals: determine win/loss and compute CLV as raw ln()
  UPDATE value_signals vs
  SET
    result = CASE
      WHEN vs.outcome = 'home_win'  AND v_match.home_score > v_match.away_score  THEN 'win'
      WHEN vs.outcome = 'away_win'  AND v_match.away_score > v_match.home_score  THEN 'win'
      WHEN vs.outcome = 'draw'      AND v_match.home_score = v_match.away_score  THEN 'win'
      ELSE 'loss'
    END,
    closing_odds = COALESCE(
      (
        SELECT os.odds FROM odds_snapshots os
        WHERE os.match_id = p_match_id
          AND os.selection = vs.outcome
          AND os.snapshot_type = 'closing'
        ORDER BY os.captured_at DESC
        LIMIT 1
      ),
      vs.closing_odds
    ),
    clv = CASE
      WHEN vs.detected_odds IS NOT NULL AND (
        SELECT os.odds FROM odds_snapshots os
        WHERE os.match_id = p_match_id
          AND os.selection = vs.outcome
          AND os.snapshot_type = 'closing'
        ORDER BY os.captured_at DESC
        LIMIT 1
      ) IS NOT NULL AND (
        SELECT os.odds FROM odds_snapshots os
        WHERE os.match_id = p_match_id
          AND os.selection = vs.outcome
          AND os.snapshot_type = 'closing'
        ORDER BY os.captured_at DESC
        LIMIT 1
      ) > 0
      THEN ROUND(
        LN(vs.detected_odds / (
          SELECT os.odds FROM odds_snapshots os
          WHERE os.match_id = p_match_id
            AND os.selection = vs.outcome
            AND os.snapshot_type = 'closing'
          ORDER BY os.captured_at DESC
          LIMIT 1
        )),
        4
      )
      ELSE vs.clv
    END
  WHERE vs.match_id = p_match_id
    AND vs.result = 'pending';

  -- Settle recommendations
  UPDATE recommendations r
  SET
    settled       = true,
    settled_at    = now(),
    outcome_result = CASE
      WHEN r.selection = 'home_win' AND v_match.home_score > v_match.away_score THEN 'win'
      WHEN r.selection = 'away_win' AND v_match.away_score > v_match.home_score THEN 'win'
      WHEN r.selection = 'draw'     AND v_match.home_score = v_match.away_score THEN 'win'
      ELSE 'loss'
    END,
    clv_pct = CASE
      WHEN r.opening_odds IS NOT NULL AND r.pre_kickoff_odds IS NOT NULL
           AND r.pre_kickoff_odds > 0
      THEN ROUND(LN(r.opening_odds / r.pre_kickoff_odds), 4)
      ELSE r.clv_pct
    END
  WHERE r.match_id = p_match_id
    AND r.settled = false;

END;
$$;

