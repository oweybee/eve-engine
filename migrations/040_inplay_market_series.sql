-- 040: in-play market movement time-series.
--
-- WHY A DEDICATED TABLE
-- odds_snapshots is pre-match / CLV-oriented (one row per book per selection,
-- snapshot_type open|signal|current|closing). The live chart needs something
-- different on every tick: the market's CURRENT shape (consensus + best price +
-- how many books), the MODEL's line at the same instant, and the MATCH STATE
-- (minute + score) that explains the movement. Storing that denormalised makes
-- the chart a single indexed range-scan instead of a multi-table join per point.
--
-- One row per (match, selection) per tick. At a 30s worker cadence a 2-hour
-- match yields ~240 rows per selection — small, and pruned by the retention
-- index below.

CREATE TABLE IF NOT EXISTS inplay_market_series (
  id              bigserial PRIMARY KEY,
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL DEFAULT now(),

  -- match state at capture time (explains WHY the market moved)
  minute          int,
  goals_home      int,
  goals_away      int,

  -- market side
  selection       text NOT NULL,          -- home|draw|away|over|under
  market          text NOT NULL DEFAULT 'h2h',
  market_line     numeric(4,2),           -- e.g. 2.5 for totals
  consensus_odds  numeric(7,3),           -- median across books (de-vig input)
  best_odds       numeric(7,3),           -- best available price
  best_bookmaker  text,
  book_count      int,                    -- how many books priced it

  -- model side at the same instant
  model_prob      numeric(6,4),           -- our live probability
  model_fair_odds numeric(7,3),
  edge            numeric(6,4),           -- model_prob * best_odds - 1

  CONSTRAINT inplay_series_selection_chk
    CHECK (selection IN ('home','draw','away','over','under'))
);

-- The chart's access pattern: one match's one selection, in time order.
CREATE INDEX IF NOT EXISTS idx_ims_match_sel
  ON inplay_market_series (match_id, selection, captured_at);

-- Retention / housekeeping sweeps by age.
CREATE INDEX IF NOT EXISTS idx_ims_captured
  ON inplay_market_series (captured_at);

-- Read-only to the frontend anon role; the engine writes via service role.
ALTER TABLE inplay_market_series ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'inplay_market_series' AND policyname = 'ims_read_all'
  ) THEN
    CREATE POLICY ims_read_all ON inplay_market_series FOR SELECT USING (true);
  END IF;
END $$;
