-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620201408, name update_settle_fn_with_no_vig_clv. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


CREATE OR REPLACE FUNCTION settle_match_signals(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_match record;
BEGIN
  SELECT status, goals_home, goals_away INTO v_match
  FROM matches WHERE id = p_match_id;

  IF v_match.status != 'completed' THEN
    RAISE EXCEPTION 'Match % is not completed (status: %)', p_match_id, v_match.status;
  END IF;

  UPDATE value_signals vs
  SET
    result = CASE
      WHEN vs.outcome = 'home' AND v_match.goals_home > v_match.goals_away  THEN 'win'
      WHEN vs.outcome = 'away' AND v_match.goals_away > v_match.goals_home  THEN 'win'
      WHEN vs.outcome = 'draw' AND v_match.goals_home = v_match.goals_away  THEN 'win'
      ELSE 'loss'
    END,
    -- Raw closing odds from odds_snapshots (for display / audit)
    closing_odds = COALESCE(
      (SELECT os.odds FROM odds_snapshots os
       WHERE os.match_id = p_match_id
         AND os.selection = vs.outcome
         AND os.snapshot_type = 'closing'
       ORDER BY os.captured_at DESC LIMIT 1),
      vs.closing_odds
    ),
    -- Raw log CLV vs stored closing line
    clv = (
      WITH snap AS (
        SELECT os.odds AS close
        FROM odds_snapshots os
        WHERE os.match_id = p_match_id
          AND os.selection = vs.outcome
          AND os.snapshot_type = 'closing'
        ORDER BY os.captured_at DESC LIMIT 1
      )
      SELECT CASE WHEN snap.close > 0 THEN ROUND(LN(vs.detected_odds / snap.close), 4) END
      FROM snap
    ),
    -- No-vig CLV: uses full 3-way h2h market from odds table
    no_vig_clv = (
      WITH cm AS (
        SELECT DISTINCT ON (o.match_id)
          o.home_odds, o.draw_odds, o.away_odds,
          (1.0/o.home_odds + 1.0/NULLIF(o.draw_odds,0) + 1.0/o.away_odds) AS total_implied
        FROM odds o
        JOIN matches m ON m.id = o.match_id
        WHERE o.match_id = p_match_id
          AND o.market = 'h2h'
          AND o.draw_odds IS NOT NULL
          AND o.fetched_at <= m.kickoff_at
        ORDER BY o.match_id, o.fetched_at DESC
      )
      SELECT ROUND(
        LN(vs.detected_odds / NULLIF(
          cm.total_implied * CASE vs.outcome
            WHEN 'home' THEN cm.home_odds
            WHEN 'draw' THEN cm.draw_odds
            WHEN 'away' THEN cm.away_odds
          END, 0
        )), 4
      )
      FROM cm WHERE cm.home_odds IS NOT NULL
    )
  WHERE vs.match_id = p_match_id AND vs.result = 'pending';

  -- Set signal_label after result and no_vig_clv are written
  UPDATE value_signals
  SET signal_label = CASE
    WHEN no_vig_clv IS NULL THEN NULL
    WHEN no_vig_clv > 0  THEN 'Market Steamer'
    WHEN no_vig_clv <= 0 AND result = 'win'  THEN 'Sharp Contrarian Edge'
    WHEN no_vig_clv <= 0 AND result = 'loss' THEN 'Market Confirmed'
  END
  WHERE match_id = p_match_id AND result IN ('win','loss');

  -- Settle recommendations
  UPDATE recommendations r
  SET
    settled       = true,
    settled_at    = now(),
    outcome_result = CASE
      WHEN r.selection = 'home_win' AND v_match.goals_home > v_match.goals_away THEN 'win'
      WHEN r.selection = 'away_win' AND v_match.goals_away > v_match.goals_home THEN 'win'
      WHEN r.selection = 'draw'     AND v_match.goals_home = v_match.goals_away  THEN 'win'
      ELSE 'loss'
    END,
    clv_pct = CASE
      WHEN r.opening_odds IS NOT NULL AND r.pre_kickoff_odds IS NOT NULL AND r.pre_kickoff_odds > 0
      THEN ROUND(LN(r.opening_odds / r.pre_kickoff_odds), 4)
      ELSE r.clv_pct
    END
  WHERE r.match_id = p_match_id AND r.settled = false;

END;
$$;

