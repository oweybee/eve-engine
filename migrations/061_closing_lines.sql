-- 061_closing_lines.sql
--
-- A CLOSING LINE, CAPTURED AT KICKOFF, FROZEN.
--
-- CLV is the only feedback this platform can get inside a week. Yield needs
-- hundreds of settled bets before it says anything; the closing line says
-- something about every single selection the moment the match starts. It is
-- also the measure `paper_trade_gate()` opens the publication gate on — 300
-- settled bets, CLV above +0.5%, z above 2 — so if CLV is wrong, the gate is
-- wrong, and nothing else about the model can be trusted either.
--
-- IT WAS WRONG. Two separate implementations, both of them measuring against
-- something that is not a closing line:
--
--   1. `fetchResults.js` reads `odds_snapshots` where `snapshot_type='closing'`.
--      Of the 32,303 rows carrying that label, 22,988 — SEVENTY-ONE PER CENT —
--      were captured AFTER kickoff, and the median one was taken 42 MINUTES
--      INTO THE MATCH. `captureSnapshot.js` labels anything from 60 minutes
--      before kickoff to 180 minutes after as "closing", so most of what is
--      stored under that name is an in-play price on a match whose score has
--      already moved. CLV measured against it is not a noisy estimate of the
--      closing line, it is a different quantity.
--
--   2. `settle_match_signals()` writes `no_vig_clv` from
--      `total_implied * outcome_odds` — PROPORTIONAL de-vig — over whichever
--      single bookmaker row happened to be fetched last, with no book filter at
--      all. `lib/devig.js` exists because proportional de-vig manufactures edge
--      on the longer leg: the 6 Aug backtest measured 49 longshots flagged, 1
--      winner, -70% yield, and called it "a de-vig artifact". The whole platform
--      moved to Shin. This one function did not, and it is the only thing that
--      has ever populated `no_vig_clv` — 816 rows of it, h2h only.
--
-- WHAT A CLOSING LINE IS HERE. The last price vector quoted STRICTLY BEFORE
-- kickoff, Shin-de-vigged, preferring the anchor:
--
--   basis 'anchor'     Pinnacle's own closing vector. The platform already
--                      rules that fair value is Shin-de-vigged Pinnacle and
--                      nothing else (lib/marketAnchor.js); the benchmark a
--                      price is judged against should be the same thing that
--                      defined value in the first place.
--   basis 'consensus'  Pinnacle did not quote. Median price per selection
--                      across the bettable panel, then Shin.
--
-- THE BASIS IS RECORDED, NOT AVERAGED OVER. Same ruling as `gap_basis` in
-- migration 058: two benchmarks in one column with nothing saying which is
-- which is how a number stops meaning anything. Filter or group by it.
--
-- Rows are written ONCE and never revised. A closing line is a record of what
-- the market said at a moment that has passed, exactly as settled history is a
-- record — only a pending offer is ever re-priced.

begin;

create table if not exists public.closing_lines (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid        not null references public.matches(id) on delete cascade,
  market        text        not null,
  market_line   numeric,
  selection     text        not null,

  -- The takeable closing price for this selection under `basis`.
  closing_odds  numeric     not null check (closing_odds > 1),
  -- Shin-de-vigged probability of this selection out of the SAME vector.
  no_vig_prob   numeric     not null check (no_vig_prob > 0 and no_vig_prob < 1),
  -- 1 / no_vig_prob. Stored so nothing downstream has to re-derive it and get
  -- a different answer.
  no_vig_odds   numeric     not null check (no_vig_odds > 1),

  basis         text        not null check (basis in ('anchor', 'consensus')),
  book_count    integer     not null check (book_count >= 1),
  overround     numeric     not null,

  kickoff_at    timestamptz not null,
  -- When the quote we froze was fetched. ALWAYS <= kickoff_at, enforced below:
  -- that constraint is the entire point of this table.
  quoted_at     timestamptz not null,
  captured_at   timestamptz not null default now(),

  constraint closing_line_is_pre_kickoff check (quoted_at <= kickoff_at)
);

-- One closing line per selection per market per line. `market_line` is null for
-- h2h and BTTS, and null never equals null in a unique constraint, so the
-- coalesce is load-bearing.
create unique index if not exists closing_lines_unique
  on public.closing_lines (match_id, market, coalesce(market_line, -1), selection);

create index if not exists closing_lines_match_idx on public.closing_lines (match_id);

-- ── Nobody in the browser reads this ────────────────────────────────────────
-- It is an engine-internal record. RLS on with no policy denies every client
-- read outright, which is the correct answer for a table no surface consumes,
-- and the service role bypasses RLS as it does everywhere else.
alter table public.closing_lines enable row level security;
revoke all on public.closing_lines from anon, authenticated;

comment on table public.closing_lines is
  'The last price vector quoted strictly BEFORE kickoff, Shin-de-vigged and frozen. The benchmark for clv and no_vig_clv on value_signals. Written once by captureClosingLines.js and never revised. See migration 061.';

commit;
