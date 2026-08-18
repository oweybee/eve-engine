-- 064_derisk_the_board.sql
--
-- Three things the board says that it cannot stand behind.
--
-- ── 1. `signal_category` still holds the retired badge words ────────────────
--
-- The 6 Aug 2026 unification ruled that the ELIGIBILITY ladder "kept its job
-- and lost its words", because it shared PRIME and VALUE with the CONVICTION
-- ladder and the two meant different things. It kept the job. It did not lose
-- the words: `categoryFor()` Title-Cased its lower-case bucket keys for no
-- reason except to produce them, and the CHECK constraint enshrined the result.
--
-- They contradict the badge beside them, measurably:
--   signal_category='Prime'  — 133 rows, MES 31 to 84, only 13 on a backed rung
--   signal_category='Value'  — 476 rows, and the platform's TOP score of 99
-- A row reading "Prime" could be a SLIGHT; the strongest reading on the site
-- was a "Value". Whichever a reader believed, one of them was lying.
--
-- The bucket keeps its job under its own key. Nothing is deleted.
--
-- ── 2. The 85-91 dead band, and PRIME ───────────────────────────────────────
--
-- No signal in the history scores between 85 and 91. Scores stop at 84 and
-- resume at 92 — and the PRIME cutoff, 88, sits inside that gap, so the most
-- emphatic claim the product can make is decided in a region nothing occupies.
--
-- It is worse than untested. EVERY row that has ever reached 85+ is a
-- DIXON_COLES totals/BTTS row on `gap_basis = 'implied'` — the LEGACY basis
-- where `market_prob` is `1/detected_odds`, the price with the bookmaker's
-- margin still in it, so the "gap" is a restatement of the price and not a
-- disagreement with anything. On the current de-vigged basis the highest score
-- ever recorded is 77. PRIME HAS NEVER BEEN EARNED BY A ROW ON THE BASIS THE
-- PRODUCT NOW USES.
--
-- The ladder is NOT re-cut. Its cutoffs are `100·(1 − 0.35^z)` inverted at
-- round multiples of sigma and inventing a new number to close the gap would be
-- exactly the arbitrary choice the ladder exists to avoid. Instead the top rung
-- is capped at the point of PUBLICATION, in lib/maxedge.ts, so the score is
-- still computed honestly and the claim is simply not made. The dead band stops
-- mattering because nothing is decided inside it any more.
--
-- ── 3. The published yield ──────────────────────────────────────────────────
--
-- `performance_summary.yield` is a mean over settled SIGNALS, which treats
-- every signal as an independent observation. They are not: the engine writes
-- several per fixture and their outcomes share one match. On the live tracked
-- cohort, 90 settled signals came from 56 fixtures.
--
--     per signal    n=90  yield +8.57%   z 0.70
--     per match     n=56  yield +14.80%  z 0.98
--
-- Clustering did not shrink the figure. It made the figure honest, and the
-- honest figure has a z below 1 — indistinguishable from zero. Meanwhile the
-- no-vig CLV on the same book is NEGATIVE. `paper_trade_gate()` already sets
-- this platform's standard at 300 settled bets with z above 2, and the headline
-- was published under neither.
--
-- The columns below let a surface publish the clustered figure and, when the
-- sample cannot support a claim, say so instead.

begin;

-- ── 1 ───────────────────────────────────────────────────────────────────────

alter table public.value_signals drop constraint if exists value_signals_signal_category_check;

update public.value_signals set signal_category = lower(signal_category)
where signal_category is not null and signal_category <> lower(signal_category);

alter table public.value_signals add constraint value_signals_signal_category_check
  check (signal_category is null or signal_category in ('prime', 'value', 'longshot'));

comment on column public.value_signals.signal_category is
  'The ELIGIBILITY bucket key (lower case), from lib/signalTier.classifyTier: may we suggest this, and do we track it. NOT a conviction rung and never printed — the words a reader sees come from mxs_band. Title Case here was the retired badge vocabulary; see migration 064.';

-- ── 3 ───────────────────────────────────────────────────────────────────────

alter table public.performance_summary
  add column if not exists settled_matches     integer,
  add column if not exists yield_clustered     numeric,
  add column if not exists yield_z             numeric,
  add column if not exists insufficient        boolean not null default true,
  add column if not exists insufficient_reason text;

comment on column public.performance_summary.yield_clustered is
  'Mean P/L per FIXTURE — the unit of independence. Average within a match, then across matches. This is the figure a surface should publish; `yield` is the per-signal version that treats correlated bets as independent observations.';
comment on column public.performance_summary.insufficient is
  'True when the settled sample cannot support publishing a yield: fewer than 100 settled fixtures, or |yield_z| below 2. Surfaces must show insufficient_reason instead of a number. Defaults TRUE so a summary written before this was computed fails closed.';

-- Everything already stored predates the clustered figures, so nothing in the
-- table has been shown to clear the bar. Fail closed until the engine
-- recomputes; the alternative is a headline that stays live on the strength of
-- a column that was never filled in.
update public.performance_summary
set insufficient = true,
    insufficient_reason = 'not yet recomputed under the clustered standard (migration 064)'
where yield_z is null;

commit;
