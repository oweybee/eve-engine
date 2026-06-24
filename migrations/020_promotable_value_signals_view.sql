-- 020_promotable_value_signals_view.sql
--
-- Canonical public view for the MaxEdge frontend and BI tooling.
--
-- Purpose: surface pending value signals with a computed `signal_tier` that
-- applies the outsider threshold (OUTSIDER_PROB_THRESHOLD = 0.15) at query
-- time, regardless of when the underlying row was written.  This guarantees
-- correctness even for rows predating migration 019 (which added the
-- signal_category column to the table).
--
-- signal_tier logic:
--   model_probability = (1 / detected_odds) + detected_edge
--     → < 0.15  (≈ market odds > 6.50 / implied < 15%) → 'Longshot Edge'
--     → ≥ 0.15                                          → 'Prime'
--
-- The view also joins match metadata so the frontend can select from a single
-- relation instead of assembling joins in the JS client.
--
-- Safe to re-run (CREATE OR REPLACE).

CREATE OR REPLACE VIEW promotable_value_signals AS
SELECT
  vs.id,
  vs.match_id,
  vs.outcome,
  vs.detected_at,
  vs.detected_odds,
  vs.detected_edge,
  vs.detected_mes,
  vs.bookmaker,
  vs.result,
  vs.kickoff_at,

  -- Engine-written category (set by insertValueSignals via categorizeSignal).
  -- Present for rows written after migration 019; NULL for legacy rows.
  vs.signal_category,

  -- Authoritative tier: re-derived from first principles so the rule is always
  -- evaluated at the current threshold, even if the stored category is stale.
  CASE
    WHEN vs.detected_odds > 0
      AND ((1.0 / vs.detected_odds) + COALESCE(vs.detected_edge, 0)) < 0.15
    THEN 'Longshot Edge'
    ELSE 'Prime'
  END AS signal_tier,

  -- Pre-computed model probability so the frontend never has to re-derive it.
  -- Matches the formula in lib/signals.ts: (1/odds) + rawEdge.
  CASE
    WHEN vs.detected_odds > 0
    THEN ROUND(
      ((1.0 / vs.detected_odds) + COALESCE(vs.detected_edge, 0))::NUMERIC,
      4
    )
    ELSE NULL
  END AS model_probability,

  -- Match metadata (denormalised for single-query frontend access)
  m.kickoff_at   AS match_kickoff_at,
  m.status       AS match_status,
  ht.name        AS home_team_name,
  at_.name       AS away_team_name,
  l.name         AS league_name

FROM  value_signals vs
JOIN  matches      m    ON m.id   = vs.match_id
JOIN  teams        ht   ON ht.id  = m.home_team_id
JOIN  teams        at_  ON at_.id = m.away_team_id
LEFT JOIN leagues  l    ON l.id   = m.league_id

WHERE vs.result = 'pending'
  AND vs.detected_edge > 0;

-- Index note: the underlying idx_vs_prime partial index (migration 019) and
-- idx_vs_detected are already visible to this view through value_signals.
-- No additional index is needed here.

COMMENT ON VIEW promotable_value_signals IS
  'Pending positive-EV signals with outsider-aware signal_tier (Prime / Longshot Edge). '
  'Authoritative source for the MaxEdge frontend signals page.';
