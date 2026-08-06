-- 050_paper_trade_harness.sql
--
-- APPLIED to production 2026-08-06. TWO DEFECTS WERE FOUND BY APPLYING IT.
--
--   1. `round(100.0 * stddev(clv) / sqrt(...), 2)` in paper_trade_report is a
--      round(double precision, integer), which Postgres does not have. The view
--      would not create. stddev() returns double; the cast is now explicit.
--      Same fault in paper_trade_gate's z-score, fixed the same way.
--
-- Both are the kind of thing only running it finds, which is why it was run.
--
-- STAGED, NOT APPLIED. Independent of 048 and 049; 051 depends on it.
--
-- WHY IT EXISTS. Cards and corners are the strongest discriminators anything in
-- the audit produced — the actual over-3.5-cards rate runs 25.3% to 59.7%
-- across model deciles, perfectly monotone, a 34.4pp range against 14.5pp for
-- the goals model, and the referee lifts correlation with actual cards from
-- 0.2075 to 0.2516. None of it can be backtested, because 33 seasons of stored
-- history contains no corner or card prices at all. So it has to be measured
-- forward, against live prices, without being published while it is measured.
--
-- paper_trades has RLS enabled and DELIBERATELY NO READ POLICY. That is not an
-- oversight to be tidied up later: this table is internal evidence, and a
-- select policy on it is the difference between a harness and a published
-- board. The service-role key bypasses RLS, so the writer and the weekly report
-- both work with no policy at all.
--
-- The gate is the point. Three conditions, all required: 300 settled bets,
-- CLV above +0.5%, and a CLV z-score above 2. Yield is reported and does not
-- gate, because yield at these sample sizes is noise — Winkelmann et al. (2024)
-- put the chance of a spuriously "significant" season under a perfectly
-- efficient market at 77.63%, which is roughly how the June 2026 board
-- happened.
--
-- ONE THING TO CHECK BEFORE APPLYING: settle_paper_trade() grades over/under
-- off market_line and grades everything else by the caller passing 1 or 0 in
-- p_actual_value. There is no push handling — an exact-line settlement
-- (actual = line) grades as a loss for both sides. Corner and card lines are
-- conventionally half-points so this cannot bite today, but it will the first
-- time a whole-number line is logged. The 'void' result is already in the CHECK
-- constraint; nothing sets it yet.

-- ============================================================================
-- MaxEdge — paper-trade harness
-- 2026-08-05
--
-- Why this exists: corners and cards showed the best discriminative power of
-- anything tested (actual-outcome range 20.7pp and 34.4pp across bins, both
-- perfectly monotone, vs 14.5pp for the goals model) -- but there are NO
-- historical corner or card prices anywhere in 33 seasons of data, so those
-- models cannot be backtested. They have to be measured forward.
--
-- This harness logs predictions against live prices and never publishes them.
-- Publication is gated on measured CLV over a real sample, not on yield over a
-- handful of bets -- Winkelmann et al. (2024) found a 77.63% chance of seeing a
-- spuriously "significant" season under a perfectly efficient market.
--
-- Nothing here writes to value_signals or any published surface.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create table if not exists public.paper_trades (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid,
  external_ref     text,                    -- fixture id from the odds feed
  kickoff_at       timestamptz not null,

  model            text not null,           -- CORNERS_POISSON | CARDS_REFEREE | DC_MLE
  model_version    text not null,
  market           text not null,           -- corners | bookings | totals | h2h
  market_line      numeric,                 -- 10.5, 3.5, 2.5 ...
  selection        text not null,           -- over | under | home | draw | away

  -- what the model thought, at the moment of logging
  model_prob       numeric not null check (model_prob > 0 and model_prob < 1),
  model_lambda     numeric,                 -- the Poisson mean behind it
  model_sigma      numeric,                 -- calibration error in force
  mxs              integer,                 -- MaxEdgeScore, for reference only

  -- what the market offered
  price_taken      numeric not null check (price_taken > 1),
  book_taken       text,
  books_quoting    integer,                 -- how many books had a price
  price_avg        numeric,                 -- market average at logging time
  logged_at        timestamptz not null default now(),
  hours_to_kickoff numeric,

  -- what the market said at the end -- this is the column that matters
  closing_price    numeric,
  closing_avg      numeric,
  clv              numeric,                 -- price_taken / closing_price - 1
  no_vig_clv       numeric,

  -- outcome
  result           text check (result in ('pending','win','loss','void')) default 'pending',
  actual_value     numeric,                 -- actual corners / cards / goals
  pl_units         numeric,
  settled_at       timestamptz,

  notes            text
);

comment on table public.paper_trades is
  'Forward measurement for models with no backtestable price history. NEVER '
  'published. Gate promotion to value_signals on paper_trade_gate().';

comment on column public.paper_trades.clv is
  'price_taken / closing_price - 1. The primary metric. Converges far faster '
  'than yield and is the only durable evidence of edge at these sample sizes.';

create index if not exists paper_trades_model_idx   on public.paper_trades (model, market, result);
create index if not exists paper_trades_kickoff_idx on public.paper_trades (kickoff_at);
create index if not exists paper_trades_pending_idx on public.paper_trades (result)
  where result = 'pending';

-- One row per model/market/line/selection/fixture, so a re-run cannot double-log.
create unique index if not exists paper_trades_dedup_idx
  on public.paper_trades (coalesce(external_ref,''), model, market,
                          coalesce(market_line, -1), selection);

alter table public.paper_trades enable row level security;
-- Deliberately no public read policy: this is internal evidence, not content.

-- ---------------------------------------------------------------------------
-- 2. Settlement: attach the closing price, compute CLV, grade the bet
-- ---------------------------------------------------------------------------

create or replace function public.settle_paper_trade(
  p_id            uuid,
  p_closing_price numeric,
  p_actual_value  numeric,
  p_closing_avg   numeric default null
) returns void
language plpgsql as $$
declare r public.paper_trades;
declare won boolean;
begin
  select * into r from public.paper_trades where id = p_id;
  if not found then raise exception 'paper_trade % not found', p_id; end if;

  -- Over/under markets grade off the line; h2h is graded by the caller
  -- passing 1 or 0 in p_actual_value.
  if r.selection = 'over' then
    won := p_actual_value > r.market_line;
  elsif r.selection = 'under' then
    won := p_actual_value < r.market_line;
  else
    won := p_actual_value >= 1;
  end if;

  update public.paper_trades
  set closing_price = p_closing_price,
      closing_avg   = p_closing_avg,
      clv           = case when p_closing_price > 1
                           then price_taken / p_closing_price - 1 end,
      result        = case when won then 'win' else 'loss' end,
      actual_value  = p_actual_value,
      pl_units      = case when won then price_taken - 1 else -1 end,
      settled_at    = now()
  where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The weekly report
-- ---------------------------------------------------------------------------

create or replace view public.paper_trade_report as
select
  model,
  market,
  selection,
  count(*)                                        as logged,
  count(*) filter (where result in ('win','loss')) as settled,
  round(100.0 * count(*) filter (where result = 'win')
        / nullif(count(*) filter (where result in ('win','loss')), 0), 1) as strike_pct,
  round(avg(price_taken), 2)                      as avg_price,
  -- the headline
  round(100.0 * avg(clv), 2)                      as avg_clv_pct,
  round((100.0 * stddev(clv) / sqrt(nullif(count(clv), 0)))::numeric, 2) as clv_stderr_pct,
  round(100.0 * sum(pl_units)
        / nullif(count(*) filter (where result in ('win','loss')), 0), 2) as yield_pct,
  round(avg(hours_to_kickoff), 1)                 as avg_hrs_before_ko,
  round(avg(books_quoting), 1)                    as avg_books_quoting,
  min(kickoff_at)::date                           as from_date,
  max(kickoff_at)::date                           as to_date
from public.paper_trades
group by model, market, selection
order by model, market, selection;

comment on view public.paper_trade_report is
  'Read this weekly. Watch avg_clv_pct against clv_stderr_pct -- a CLV of +2% '
  'with a standard error of 3% is not evidence of anything yet.';

-- ---------------------------------------------------------------------------
-- 4. The gate. This is the whole point of the harness.
-- ---------------------------------------------------------------------------

create or replace function public.paper_trade_gate(
  p_min_n         integer default 300,
  p_min_clv       numeric default 0.005,   -- +0.5% CLV
  p_min_clv_zscore numeric default 2.0
) returns table (
  model         text,
  market        text,
  settled       integer,
  avg_clv_pct   numeric,
  clv_zscore    numeric,
  yield_pct     numeric,
  verdict       text
)
language sql stable as $$
  with s as (
    select pt.model, pt.market,
           count(*) filter (where pt.result in ('win','loss')) as n,
           avg(pt.clv)                                          as clv,
           stddev(pt.clv)::numeric                              as clv_sd,
           count(pt.clv)                                        as n_clv,
           sum(pt.pl_units)                                     as pl
    from public.paper_trades pt
    group by pt.model, pt.market
  )
  select s.model, s.market, s.n::int,
         round(100 * s.clv, 2),
         round(s.clv / nullif(s.clv_sd / sqrt(nullif(s.n_clv, 0)), 0), 2),
         round(100 * s.pl / nullif(s.n, 0), 2),
         case
           when s.n < p_min_n then
             format('HOLD - %s of %s bets needed', s.n, p_min_n)
           when s.clv < p_min_clv then
             format('FAIL - CLV %s%% below the %s%% bar', round(100*s.clv,2), round(100*p_min_clv,2))
           when s.clv / nullif(s.clv_sd / sqrt(nullif(s.n_clv,0)), 0) < p_min_clv_zscore then
             format('HOLD - CLV positive but z=%s, need %s',
                    round(s.clv / nullif(s.clv_sd/sqrt(nullif(s.n_clv,0)),0), 2), p_min_clv_zscore)
           else
             format('PASS - CLV %s%% at z=%s over %s bets. Cleared to publish.',
                    round(100*s.clv,2),
                    round(s.clv / nullif(s.clv_sd/sqrt(nullif(s.n_clv,0)),0), 2), s.n)
         end
  from s
  order by s.n desc;
$$;

comment on function public.paper_trade_gate is
  'A model may only be promoted to value_signals on PASS. Three conditions, all '
  'required: 300+ settled bets, CLV above +0.5%, and a CLV z-score above 2. '
  'Yield is reported but deliberately does NOT gate -- it is far too noisy at '
  'these sample sizes, which is how the June 2026 board happened.';

-- ---------------------------------------------------------------------------
-- 5. Register the models under test
-- ---------------------------------------------------------------------------

create table if not exists public.paper_models (
  model         text primary key,
  version       text not null,
  market        text not null,
  status        text not null default 'testing'
                check (status in ('testing','passed','failed','retired')),
  hypothesis    text,
  started_at    timestamptz not null default now(),
  notes         text
);

insert into public.paper_models (model, version, market, hypothesis, notes) values
  ('CARDS_REFEREE', 'v1', 'bookings',
   'Total cards are more predictable than goals, and the referee is a third of '
   'the signal that bookmakers do not price.',
   'Discrimination on 54,010 historical matches: actual over-3.5 rate runs '
   '25.3% -> 59.7% across model deciles, perfectly monotone (34.4pp range, vs '
   '14.5pp for the goals model). Adding referee tendency lifts correlation with '
   'actual cards from 0.2075 to 0.2516. Referee spread SD 0.418 cards/match, '
   'range 1.31 to 4.94. UNTESTED against prices - none exist historically.'),

  ('CORNERS_POISSON', 'v1', 'corners',
   'Corner volume is driven by persistent team style and is priced lazily.',
   'Discrimination: actual over-10.5 rate runs 39.4% -> 60.1% across deciles, '
   'perfectly monotone (20.7pp range). UNTESTED against prices.'),

  ('DC_MLE', 'v1', 'totals',
   'Attack/defence fitted jointly by weighted MLE fixes the totals component '
   'that the pi-ratings hybrid got wrong.',
   'Platt slope improved 0.099 -> 0.437; betting moved from -7% to break-even '
   'out of sample. Behind Pinnacle on Brier (0.6357 vs 0.6140). Logged for '
   'reference, not expected to pass.')
on conflict (model) do nothing;

commit;

-- ============================================================================
-- Weekly routine
-- ============================================================================
--   select * from public.paper_trade_report;
--   select * from public.paper_trade_gate();
--
-- Promote nothing until the gate says PASS. If a model sits on
-- "HOLD - CLV positive but z=1.4" for months, that is the harness working:
-- it means the edge, if real, is too small to distinguish from noise, which is
-- also too small to sell.
-- ============================================================================
