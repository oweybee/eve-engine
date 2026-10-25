-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620201349, name add_no_vig_clv_and_signal_label. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 1. Add columns
ALTER TABLE value_signals
  ADD COLUMN IF NOT EXISTS no_vig_clv numeric,
  ADD COLUMN IF NOT EXISTS signal_label text;

ALTER TABLE performance_summary
  ADD COLUMN IF NOT EXISTS avg_no_vig_clv numeric;

-- 2. Backfill no_vig_clv from the odds table (latest h2h 3-way market before kickoff)
WITH closing_market AS (
  SELECT DISTINCT ON (o.match_id)
    o.match_id,
    o.home_odds,
    o.draw_odds,
    o.away_odds,
    (1.0/o.home_odds + 1.0/NULLIF(o.draw_odds,0) + 1.0/o.away_odds) AS total_implied
  FROM odds o
  JOIN matches m ON m.id = o.match_id
  WHERE o.market = 'h2h'
    AND o.draw_odds IS NOT NULL
    AND o.fetched_at <= m.kickoff_at
  ORDER BY o.match_id, o.fetched_at DESC
)
UPDATE value_signals vs
SET no_vig_clv = ROUND(
  LN(
    vs.detected_odds / NULLIF(
      cm.total_implied * CASE vs.outcome
        WHEN 'home' THEN cm.home_odds
        WHEN 'draw' THEN cm.draw_odds
        WHEN 'away' THEN cm.away_odds
      END,
    0)
  ),
  4
)
FROM closing_market cm
WHERE cm.match_id = vs.match_id
  AND vs.result IN ('win', 'loss')
  AND cm.home_odds IS NOT NULL;

-- 3. Backfill signal_label based on no_vig_clv
UPDATE value_signals
SET signal_label = CASE
  WHEN no_vig_clv IS NULL THEN NULL
  WHEN no_vig_clv > 0  THEN 'Market Steamer'
  WHEN no_vig_clv <= 0 AND result = 'win'  THEN 'Sharp Contrarian Edge'
  WHEN no_vig_clv <= 0 AND result = 'loss' THEN 'Market Confirmed'
  ELSE NULL
END
WHERE result IN ('win', 'loss');

-- 4. Backfill avg_no_vig_clv in performance_summary
UPDATE performance_summary
SET avg_no_vig_clv = (
  SELECT ROUND(AVG(no_vig_clv), 4)
  FROM value_signals
  WHERE result IN ('win','loss') AND no_vig_clv IS NOT NULL
)
WHERE calculated_at = (SELECT MAX(calculated_at) FROM performance_summary);

