-- 134 — the rung is not the score band, and it needs its own column
--
-- `value_signals.mxs_band` is the SCORE band: what the number alone says. It
-- has meant that on all 2,588 rows written so far, and `postToX.bandOf` reads
-- it under that meaning.
--
-- THE WORD THE PRODUCT PRINTS IS NOT THAT. Since 26 Aug 2026 the printed rung
-- comes from the price-and-edge box (lib/signalTier.rungFor), and the two
-- disagree routinely by design: a 99-scoring row at a 4% edge is a WATCH. The
-- rung was computed at every read and persisted nowhere, so three copies of
-- one formula had to stay in step -- the engine, the frontend mirror and
-- signal_rung() in 102.
--
-- Redefining `mxs_band` would have been the cheap fix and it is the wrong one:
-- it would retroactively change what every historical row claims, which is the
-- exact failure `gap_basis` and `mes_basis` exist to prevent. So the rung gets
-- a column and `mxs_band` keeps its meaning.
--
-- ORDER OF DEPLOY: THIS LANDS BEFORE THE ENGINE. `scoreSignal` emits `rung` as
-- of the same release, and a missing column fails every insert, not just the
-- new field. engine.maxedge.test.js asserts the column list for this reason.

alter table public.value_signals
  add column if not exists rung text;

-- The six words and nothing else. NULL is a real state and means "we could not
-- place this row on the ladder" -- an architecture with no measured error bar,
-- or a row below the box with no score. That is different from NIL, which means
-- we placed it and it came last.
alter table public.value_signals
  drop constraint if exists value_signals_rung_check;
alter table public.value_signals
  add constraint value_signals_rung_check
  check (rung is null or rung in ('PRIME','EDGE','WATCH','SLIGHT','TRACE','NIL'));

-- The board reads it per fixture window; the record reads it per band.
create index if not exists value_signals_rung_idx
  on public.value_signals (rung)
  where rung is not null;

comment on column public.value_signals.rung is
  'The conviction word the product prints, from the price+edge box '
  '(lib/signalTier.rungFor). NOT mxs_band, which is the score band and '
  'disagrees with this by design. NULL means unplaceable, never NIL.';

-- NOT BACKFILLED, DELIBERATELY. Every historical row was written under a
-- different convention (mes_basis up to and including 'yield_calibrated'),
-- where the score demoted inside the box and an unscored row got no rung at
-- all. Computing today's rung for those rows would state a claim the product
-- never made about them. Rows from 'box_rung_v1' onward carry it; everything
-- before reads NULL and is read through mxs_band as it always was.
