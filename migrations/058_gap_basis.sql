-- 058_gap_basis.sql — say which market probability a row's gap was measured
-- against, because from 7 Aug 2026 there are two answers and the ledger is
-- meant to be a record.
--
-- THE DEFECT THIS CLOSES. `value_signals.market_prob` was written as
-- `1 / detected_odds` — the raw price, with the bookmaker's margin still in it —
-- so `prob_gap` reduced to exactly `detected_edge / detected_odds`. Verified
-- across all 482 scored rows in production before this migration: every one,
-- across all seven architectures, without exception.
--
-- A raw `1/odds` vector sums to MORE than one: 1.0348 on average across the live
-- 1X2 board, even taking the best price on every outcome across 15+ books. So
-- each reciprocal overstates its outcome's probability, the market looks more
-- likely than it is, and our disagreement looks SMALLER than it is. Every score
-- was too LOW. Measured over the 46 scored 1X2 selections live on 7 Aug: mean
-- MXS 40.5 as shipped against 51.7 de-vigged, and 3 rows clearing the 65 backing
-- line where 8 would.
--
-- `maxedge_score(gap, sigma, z_gate)` IS NOT TOUCHED. The formula was always
-- right; it was handed the wrong gap. This migration adds no function and
-- changes no arithmetic.
--
-- WHY HISTORY IS NOT REWRITTEN. Backfilling would need the sibling prices as
-- they stood at each detection, and they are not reliably recoverable. Measured
-- against `odds_snapshots` on 7 Aug 2026: of 377 scored 1X2 rows, only 94 (25%)
-- reproduce their OWN detected price from the nearest prior snapshot, 99 (26%)
-- have no usable snapshot at all, and the remaining 184 miss by 3.08% on
-- average — the same order of magnitude as the 3.4% margin the correction
-- removes. A backfill would therefore inject noise as large as the effect it
-- claims to fix, onto the settled history that `model_calibration` measures its
-- sigmas from. So the old rows keep their old numbers and say so.
--
-- Which means: DO NOT MIX THE TWO IN AN AGGREGATE. A query that averages `mxs`
-- or `prob_gap` across the boundary is averaging two different measurements.
-- Filter on `gap_basis` or group by it.

alter table value_signals
  add column if not exists gap_basis text;

-- Everything that exists at this moment was measured the old way, by definition:
-- nothing has written the new convention yet.
update value_signals
   set gap_basis = 'implied'
 where gap_basis is null;

-- THE DEFAULT IS THE OLD CONVENTION, DELIBERATELY, so this migration and the
-- engine that writes the new one can deploy IN EITHER ORDER — the same property
-- 057 was given for the six-rung ladder.
--
-- Apply this first and the engine still running today's code writes rows with no
-- gap_basis of their own; they take 'implied', which is what they actually are.
-- Ship the engine first and its inserts name 'devigged' explicitly, so the
-- default never applies to them. A default of 'devigged' would have labelled
-- every row the OLD engine wrote after this migration as de-vigged, which is the
-- one outcome the column exists to prevent.
alter table value_signals
  alter column gap_basis set default 'implied';

-- Bounded to the two conventions that exist, in the same spirit as 056 bounding
-- `mxs_band` to the rungs the product can actually say. A third value here would
-- mean a third meaning for `prob_gap` that nothing documents.
alter table value_signals
  drop constraint if exists value_signals_gap_basis_check;
alter table value_signals
  add constraint value_signals_gap_basis_check
  check (gap_basis is null or gap_basis in ('implied', 'devigged'));

comment on column value_signals.gap_basis is
  'Which market probability prob_gap was measured against. ''implied'' = market_prob is 1/detected_odds, margin included (rows detected before 7 Aug 2026). ''devigged'' = market_prob is the Shin-de-vigged probability of this outcome from the complete price vector the signal was detected against. The two are not comparable; never average mxs or prob_gap across them.';

comment on column value_signals.market_prob is
  'The market''s probability for this selection. Under gap_basis=''devigged'' this is margin-free (Shin), which is what makes prob_gap = model_prob - market_prob an honest disagreement rather than a restatement of the price.';
