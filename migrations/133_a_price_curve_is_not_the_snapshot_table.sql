-- 133 — a price curve is not the snapshot table
--
-- APPLIED 8 Oct 2026, on the owner's instruction. Verified as anon after:
-- 44,098 curve rows over 346 fixtures, while `odds_snapshots` itself still
-- answers that seat with 5,127 rows. The derived figure is public; the table
-- it comes from is exactly as gated as it was.
--
-- ── THE PROBLEM THIS ANSWERS ────────────────────────────────────────────
--
-- `odds_snapshots` carries the same tier policy as `odds`:
--
--     current_tier() <> 'free' OR match_id IN preview_priced_match_ids()
--
-- which is the right rule for the SNAPSHOT TABLE, because that is every book's
-- quote at every scan and it is what a member pays for. It is the wrong rule
-- for a sparkline. Measured 8 Oct on the deployed board: a signed-out reader
-- got ONE pulse card and NO curve on it, out of 346 fixtures with snapshots in
-- the last 72 hours — so the one board whose entire subject is a price moving
-- drew no price moving.
--
-- ── WHAT THIS VIEW GIVES AWAY, AND WHAT IT DOES NOT ─────────────────────
--
-- The BEST price per selection per hour, over 72 hours. Not which book held
-- it, not the spread, not the book-by-book table, and no MaxEdge number: no
-- edge, no fair price, no model. A curve of best prices is the shape every
-- odds comparison site publishes on its own front page, and a reader who can
-- see the current best price — which migration 130 publishes — can watch it
-- move by reloading. This saves them the reloading.
--
-- THE HOUR IS THE RESOLUTION AND IT IS NOT A PERFORMANCE CHOICE. Snapshots
-- land several times an hour and per-book; collapsing to one best price per
-- hour is what makes this a CURVE rather than the table with the names off,
-- and 72 points is more than any sparkline draws. `lib/priceSeries` already
-- caps what it draws at 24 points, so the view is not the constraint.
--
-- ── WHY A DEFINER-STYLE VIEW IS SAFE HERE ───────────────────────────────
--
-- It bypasses the tier policy on purpose, which is the only way to publish a
-- derived figure from a gated table. It is safe for the same reason 130's is:
-- the derived figure is strictly LESS than the table. A caller cannot recover
-- one book's price from a max, cannot ask it about a market outside the three
-- listed, and cannot reach a row older than the window.

create or replace view public.v_price_curve as
select
  match_id,
  selection,
  date_trunc('hour', captured_at) as hour,
  max(odds)                       as best_odds,
  count(distinct bookmaker)       as books
from public.odds_snapshots
where captured_at > now() - interval '72 hours'
  and odds is not null
  and odds > 1
  and selection in ('home', 'draw', 'away', 'over', 'under', 'btts_yes', 'btts_no')
group by match_id, selection, date_trunc('hour', captured_at);

comment on view public.v_price_curve is
  'Best price per selection per hour over 72 hours. Publishes a derived curve '
  'from the tier-gated `odds_snapshots` table: the max and the book count, '
  'never which book. See migration 133.';

grant select on public.v_price_curve to anon, authenticated;
