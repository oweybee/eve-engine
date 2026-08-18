-- 060_market_prob_scale_invariant.sql
--
-- THE PRICE/CONSENSUS SCALE MISMATCH, CLOSED AT THE WRITE LAYER.
--
-- One product decides whether any EV- or Kelly-based number on this platform
-- means anything:
--
--     market_prob × detected_odds
--
-- `market_prob` is the de-vigged probability of the SAME side, at the SAME
-- line, out of the SAME vector the price was taken from. So the product is
-- exactly 1/overround of the market the reader can bet into. A real book keeps
-- margin, so it lands BELOW 1 — across a panel of best prices, 0.94–0.99.
--
-- ABOVE 1 IS NOT ROUNDING. It says the de-vigged "fair" line thinks the outcome
-- is likelier than the price you can take. On a two-way market that is true of
-- BOTH legs at once, so the over and the under both clear the EV threshold, and
-- the board publishes two contradictory bets on one market. Measured 18 Aug
-- 2026, before this migration:
--
--     market   basis      n    avg(mp×odds)   rows > 1.00
--     h2h      devigged  423     0.9750            25
--     totals   devigged  106     1.0167           100
--     btts     devigged   39     1.0097            21
--
-- and 60 totals fixtures plus 13 BTTS fixtures carried BOTH sides flagged as
-- value. Six of the totals rows were still PENDING — live on the board.
--
-- THE CAUSE was `lib/secondaryMarkets.bestTwoWay`, fixed in the same change.
-- It took max(over) and max(under) independently over every row the caller
-- handed it, and computeValues hands it TWENTY-FOUR HOURS of price history from
-- every book on the feed — `apifootball_live` (an IN-PLAY feed) and the
-- excluded books included. So the vector paired the best over at one book on
-- Tuesday morning with the best under at another book on Tuesday evening. Its
-- mean overround across 2,802 live totals vectors was 0.9844 — BELOW ONE — and
-- 778 were outright synthetic arbitrages, the worst at 0.361. De-vigging
-- normalises a vector to sum to 1, so a sub-1 vector is scaled UP and every leg
-- comes out beating its own price. The line ranking made it worse: it chose the
-- line with the LOWEST overround, which is a direct search for the most
-- corrupted vector on the fixture.
--
-- The h2h path never had this. `computeConsensus` already deduped to each
-- book's latest quote, filtered to bettable books and dropped palpable
-- outliers; `bestTwoWay` did none of the three. It now does all three.
--
-- WHY A TRIGGER AND NOT ONLY A CODE FIX. Same reasoning as
-- `trg_score_needs_measured_sigma`: a read-side filter is a promise kept by
-- every call site remembering it, and the engine has several write paths
-- (computeValues, computeApiValues, computeInplayValues, computeModelBoard)
-- that each derive `market_prob` their own way. The invariant belongs where the
-- writer is. It NULLS rather than RAISES, so a pricing regression becomes a
-- withheld score and never an ingestion outage.

begin;

-- ── The write-layer guard ───────────────────────────────────────────────────

create or replace function public.score_needs_coherent_market_prob()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  product   numeric;
  allowance numeric;
begin
  -- Nothing to check. A row with no market probability carries no de-vigged
  -- claim, and a row with no price cannot have one evaluated.
  if new.market_prob is null or new.detected_odds is null or new.detected_odds <= 1 then
    return new;
  end if;

  -- LEGACY ROWS ARE NOT IN SCOPE, DELIBERATELY. `gap_basis = 'implied'` means
  -- `market_prob` IS `1 / detected_odds` — the price with the bookmaker's
  -- margin still in it — which migration 058 recorded rather than rewrote,
  -- because the sibling prices at each historical detection are not reliably
  -- recoverable. Those rows sit at exactly 1.0 by construction. Holding them to
  -- a de-vig invariant would be testing them for something they never claimed.
  if coalesce(new.gap_basis, 'devigged') = 'implied' then
    return new;
  end if;

  -- `market_prob` is numeric(6,4), so storage rounds it by up to 5e-5 and that
  -- error is multiplied by the price. Allow exactly that much and not a tick
  -- more — every real violation measured is two to three orders of magnitude
  -- larger (the worst live row was 1.1731).
  allowance := 1 + 0.00005 * new.detected_odds;
  product   := new.market_prob * new.detected_odds;

  if product <= allowance then
    return new;
  end if;

  new.score_withheld_reason := format(
    'market_prob %s x detected_odds %s = %s, above 1 — the de-vigged fair line beats the price it was taken from, so this is not a market that existed',
    new.market_prob, new.detected_odds, round(product, 4));

  -- Strip the market side and everything derived from it. The PRICE, the EDGE,
  -- the model probability and the RESULT all survive: the row is still a record
  -- of what was quoted and what happened, which is what settled history is for.
  new.market_prob := null;
  new.prob_gap    := null;
  new.model_sigma := null;
  new.mxs         := null;
  new.mxs_band    := null;
  return new;
end $$;

-- Fires BEFORE `trg_score_needs_measured_sigma` (t < z in trigger-name order),
-- which then sees a null `mxs` and returns early, leaving this reason standing.
drop trigger if exists trg_score_needs_coherent_market_prob on public.value_signals;
create trigger trg_score_needs_coherent_market_prob
  before insert or update on public.value_signals
  for each row execute function public.score_needs_coherent_market_prob();

-- ── The rows already written ────────────────────────────────────────────────

-- (a) Provably incoherent, whatever wrote them.
update public.value_signals
set score_withheld_reason = format(
      'market_prob x detected_odds = %s, above 1 — scored against a price vector that never existed (migration 060)',
      round(market_prob * detected_odds, 4)),
    market_prob = null, prob_gap = null, model_sigma = null,
    mxs = null, mxs_band = null
where coalesce(gap_basis, 'devigged') <> 'implied'
  and market_prob is not null
  and detected_odds > 1
  and market_prob * detected_odds > 1 + 0.00005 * detected_odds;

-- (b) THE WHOLE TWO-WAY DE-VIGGED COHORT, not only the rows that crossed 1.00.
-- `bestTwoWay` was wrong for every one of them — it is not that some rows drew
-- a bad vector, it is that the construction paired legs from different books at
-- different moments and then RANKED LINES BY LOWEST OVERROUND. The six totals
-- rows that happened to land under 1.00 averaged 0.9954, an overround of 1.005,
-- which is not a real two-way market either (a genuine best-price panel runs
-- 1.03–1.06). Keeping them because they cleared a threshold would be keeping
-- the ones that got away with it.
--
-- History is not rewritten, only the CLAIM is withheld — the same shape as
-- `trg_score_needs_measured_sigma` and the publication gate. `detected_odds`,
-- `detected_edge`, `model_prob`, `result` and `clv` are untouched, so
-- /performance keeps every settled row and `model_calibration` is unaffected
-- (its sigmas come from `research_dc_preds` via
-- `refresh_disagreement_calibration()`, not from this table).
update public.value_signals
set score_withheld_reason =
      'two-way market_prob was de-vigged from a vector built out of 24h of price history across books and feeds, not the priced line at one moment — see migration 060',
    market_prob = null, prob_gap = null, model_sigma = null,
    mxs = null, mxs_band = null
where gap_basis = 'devigged'
  and market in ('totals', 'btts', 'corners', 'bookings')
  and market_prob is not null;

-- ── The recurring health check ──────────────────────────────────────────────

-- `security_invoker` per the 059 ruling: a plain view runs with its owner's
-- rights and would serve `value_signals` past RLS. This is an operations view
-- and the client roles have no business reading it at all, so the grants go
-- too.
create or replace view public.market_prob_scale_check
with (security_invoker = on) as
select
  coalesce(market, 'h2h')                                              as market,
  count(*)                                                             as scored_rows,
  round(avg(market_prob * detected_odds), 4)                           as avg_consistency,
  round(min(market_prob * detected_odds), 4)                           as min_consistency,
  round(max(market_prob * detected_odds), 4)                           as max_consistency,
  count(*) filter (
    where market_prob * detected_odds > 1 + 0.00005 * detected_odds)   as rows_over_one,
  case
    when count(*) = 0
      then 'GREEN — no scored rows'
    when count(*) filter (
      where market_prob * detected_odds > 1 + 0.00005 * detected_odds) > 0
      then 'RED — a fair line beats the price it was taken from'
    when avg(market_prob * detected_odds) not between 0.94 and 0.99
      then 'RED — outside the 0.94-0.99 residual-margin band'
    else 'GREEN'
  end                                                                  as verdict
from public.value_signals
where gap_basis = 'devigged'          -- see the trigger: 'implied' is legacy
  and market_prob  is not null
  and detected_odds is not null
  and detected_odds > 1
group by 1;

comment on view public.market_prob_scale_check is
  'Health check for the price/consensus scale invariant: market_prob x detected_odds must sit in 0.94-0.99 for every market and no row may exceed 1.00. Read by the engine status report. GREEN on every row is the release gate for any EV- or Kelly-based score.';

revoke all on public.market_prob_scale_check from anon, authenticated;

commit;
