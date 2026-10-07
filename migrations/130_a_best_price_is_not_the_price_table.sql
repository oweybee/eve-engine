-- 130 — a best price is not the price table
--
-- ── THE PROBLEM THIS ANSWERS ────────────────────────────────────────────
--
-- `odds` is tier-gated: `tiered_read_odds` lets a free reader see prices for
-- the ten fixtures in `preview_priced_match_ids()` and nothing else. That is
-- the right rule for the price TABLE, which is the book-by-book comparison
-- members pay for.
--
-- It is the wrong rule for one number. The hit-rate board was built to read
-- `matches` and nothing else, so every figure on it is the same at every tier
-- and the page costs no paywall reasoning. Adding a best price to the card put
-- a gated read on an ungated page: measured 8 Oct, a logged-out reader sees a
-- price on 10 of 738 upcoming fixtures and a member sees 311. The Min. odds
-- filter is close to useless for the first reader, and a board that shows a
-- price on one card in seventy reads as broken rather than as gated.
--
-- ── WHAT THIS VIEW GIVES AWAY, AND WHAT IT DOES NOT ─────────────────────
--
-- ONE ROW PER SELECTION: the best current price and the number of books
-- quoting it. Not which book — that is the thing a reader opens an account to
-- act on, and it stays behind the table. Not the spread, not the book-by-book
-- comparison, not any MaxEdge number: no edge, no fair price, no model.
--
-- A best price is a fact every bookmaker publishes on its own front page. The
-- product is not the price; it is the model beside it and the record behind
-- it. Gating a number anyone can read in four browser tabs costs a free reader
-- a working board and costs a member nothing.
--
-- ── WHY IT IS A DEFINER VIEW AND WHY THAT IS SAFE HERE ──────────────────
--
-- The view bypasses `tiered_read_odds` on purpose, which is the only way to
-- publish a derived figure from a gated table. It is safe because the derived
-- figure is strictly less than the table: a caller cannot recover a single
-- book's price from a max, cannot ask it about a market outside the three
-- listed, and cannot reach a row older than six hours.
--
-- SIX HOURS IS THE SAME WINDOW THE BOARD READS, and it is not a performance
-- bound. A price nobody has quoted since this morning is not a price, and the
-- card names a figure a reader is meant to be able to go and take.
--
-- OWNER DECISION. This file is written and NOT APPLIED. It moves a line
-- between the free and paid product, which is not a migration's call to make.

create or replace view public.v_best_prices as
with fresh as (
  select
    o.match_id,
    o.bookmaker,
    o.market,
    o.market_line,
    o.home_odds,
    o.draw_odds,
    o.away_odds,
    o.fetched_at,
    -- THE TABLE IS APPEND-ONLY, so the freshest row per book is taken BEFORE
    -- any max. A plain max() over the window returns the best price any book
    -- showed at any point in it, which is a price that may have lasted a
    -- minute. Same rule `lib/portal/bookPrices` applies in the browser.
    row_number() over (
      partition by o.match_id, o.bookmaker, o.market, o.market_line
      order by o.fetched_at desc
    ) as rn
  from public.odds o
  where o.fetched_at > now() - interval '6 hours'
    and o.market in ('h2h', 'totals', 'btts')
    and (o.market_line is null or o.market_line in (1.5, 2.5, 3.5))
),
-- THREE MARKETS SHARE ONE COLUMN SHAPE and the unpivot is where that is
-- resolved, once. `home_odds` is the Over price on a totals row and the Yes
-- price on a btts row; reading it without the market is the bug that got
-- /best-prices deleted, and a view is the right place for that rule to live
-- exactly once rather than in every caller.
quotes as (
  select match_id, bookmaker, 'h2h'::text as market, null::numeric as line,
         'home'::text as selection, home_odds as price, fetched_at
    from fresh where rn = 1 and market = 'h2h'
  union all
  select match_id, bookmaker, 'h2h', null, 'draw', draw_odds, fetched_at
    from fresh where rn = 1 and market = 'h2h'
  union all
  select match_id, bookmaker, 'h2h', null, 'away', away_odds, fetched_at
    from fresh where rn = 1 and market = 'h2h'
  union all
  select match_id, bookmaker, 'totals', market_line, 'over', home_odds, fetched_at
    from fresh where rn = 1 and market = 'totals'
  union all
  select match_id, bookmaker, 'totals', market_line, 'under', away_odds, fetched_at
    from fresh where rn = 1 and market = 'totals'
  union all
  select match_id, bookmaker, 'btts', null, 'btts_yes', home_odds, fetched_at
    from fresh where rn = 1 and market = 'btts'
  union all
  select match_id, bookmaker, 'btts', null, 'btts_no', away_odds, fetched_at
    from fresh where rn = 1 and market = 'btts'
)
select
  match_id,
  market,
  line,
  selection,
  max(price) as best_odds,
  -- HOW MANY BOOKS ARE QUOTING IT. "Best" of one book is best of nothing, and
  -- the surface needs to be able to say so. The book's NAME is deliberately
  -- not here; that is the table's to give.
  count(distinct bookmaker) as books,
  max(fetched_at) as read_at
from quotes
where price is not null and price > 1
group by match_id, market, line, selection;

comment on view public.v_best_prices is
  'Best current price per selection, over a six-hour window. Publishes a '
  'derived figure from the tier-gated `odds` table: the max and the book '
  'count, never which book. See migration 130.';

grant select on public.v_best_prices to anon, authenticated;
