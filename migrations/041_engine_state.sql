-- 041: small key/value store for engine runtime state that must survive process
-- restarts. First consumer: the Odds API credit guard (odds_api_quota), which
-- persists x-requests-remaining so a restarted loop can't forget the budget.
CREATE TABLE IF NOT EXISTS engine_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE engine_state ENABLE ROW LEVEL SECURITY;
-- Service role only (engine writes); no anon policy — this is internal state.
