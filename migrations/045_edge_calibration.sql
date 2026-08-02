-- 045_edge_calibration.sql
--
-- Daily snapshot of what the settled book says about the edge bands.
--
-- The PRIME box in lib/signalTier.js (odds 1.40-3.00, edge 4-10%) is a fit to
-- one window: the Jun 15 - Jul 3 back-test. It has never been re-checked on
-- fresh results, and a band picked as the best cell of a matrix will always
-- look better in the window it was picked from than it does afterwards. This
-- table is the audit trail that catches that: one row per day, recording what
-- the whole edge response looked like and what the sweep would have chosen.
--
-- It is deliberately a HISTORY, not a singleton. A single current-best band is
-- worth very little — the useful signal is whether the same band keeps winning
-- as the sample grows, or whether the "optimum" wanders from week to week
-- (which is itself the finding: no resolvable sweet spot yet, hold the box).
--
-- Nothing reads this table to change behaviour. The engine's thresholds stay
-- hard-coded in lib/signalTier.js and only a human edits them. This records the
-- evidence for that edit; it does not make it.

CREATE TABLE IF NOT EXISTS edge_calibration (
  as_of_date        date PRIMARY KEY,
  calculated_at     timestamptz NOT NULL DEFAULT now(),

  -- Scope of the book this snapshot was computed from.
  phase             text NOT NULL DEFAULT 'prematch',
  epoch_at          timestamptz,               -- in-sample / out-of-sample split
  sample_from       timestamptz,
  sample_to         timestamptz,
  settled_n         integer NOT NULL DEFAULT 0,

  -- The current PRIME box, measured over the whole settled book...
  prime_n           integer,
  prime_wins        integer,
  prime_strike      numeric,
  prime_yield       numeric,
  prime_yield_lo    numeric,                   -- 90% bootstrap interval, for display
  prime_yield_hi    numeric,
  prime_yield_lo_adj numeric,                  -- the bound the verdict compares on
  prime_avg_clv     numeric,

  -- Settled rows whose CLV fell outside ±100%, i.e. a broken closing price.
  -- Recorded because CLV is the fastest read on whether a band is real, and a
  -- silently degrading close would make that read worse over time with nothing
  -- in the record to show when it started.
  clv_outliers      integer,

  -- ...and measured only on rows detected AFTER the epoch, i.e. the rows the
  -- box was NOT fitted on. This pair is the headline: a box whose out-of-sample
  -- number is far below its in-sample number is decaying, and that gap is the
  -- single most important thing this whole job exists to surface.
  prime_oos_n       integer,
  prime_oos_yield   numeric,

  -- What a lower-bound-ranked sweep of the edge window would pick today.
  best_edge_min     numeric,
  best_edge_max     numeric,                   -- NULL = unbounded above
  best_n            integer,
  best_yield        numeric,
  best_yield_lo     numeric,                   -- multiplicity-adjusted lower bound
  best_oos_n        integer,
  best_oos_yield    numeric,

  -- Best-of-N: N, and the correction applied for it, belong in the record. A
  -- lower bound quoted without the number of bands it was selected from is not
  -- interpretable, and re-reading this table in six months without them would
  -- be re-making the original mistake on the audit trail itself.
  boxes_tested      integer,
  boxes_eligible    integer,
  per_test_alpha    numeric,
  sweep_z           numeric,

  -- 'insufficient' | 'hold' | 'advisory' | 'shift'
  recommendation    text NOT NULL DEFAULT 'insufficient'
    CHECK (recommendation IN ('insufficient', 'hold', 'advisory', 'shift')),
  reason            text,
  bets_needed       integer,                   -- until the verdict could change

  -- Full tables, kept so drift can be charted without replaying history.
  edge_bands        jsonb,
  odds_bands        jsonb,
  top_candidates    jsonb
);

COMMENT ON TABLE edge_calibration IS
  'Daily re-derivation of the profitable edge band from settled value_signals. '
  'Evidence for moving the PRIME box in lib/signalTier.js; never applied automatically.';

CREATE INDEX IF NOT EXISTS idx_edge_calibration_calculated
  ON edge_calibration (calculated_at DESC);

ALTER TABLE edge_calibration ENABLE ROW LEVEL SECURITY;
-- Service role only. This is the engine's own research record: it exposes the
-- exact bands being evaluated and how thin the evidence behind them is, which
-- is not something to hand an anonymous visitor. No anon policy is created.
