-- 066_price_liveness.sql
--
-- A PRICE NOBODY WAS OFFERING IS NOT A PRICE, AND CLV CANNOT TELL THE
-- DIFFERENCE.
--
-- CLV measured against the close cannot separate "we found a genuinely better
-- price" from "we recorded a price that was never takeable". Both produce
-- identical positive CLV, and the second one produces MORE of it. That is not a
-- hypothetical: measured on the settled book, the signals whose detected price
-- was above the best any book quoted within half an hour of detection carry
-- +4.85% (totals), +4.58% (h2h) and +3.00% (BTTS) no-vig CLV — the unavailable
-- rows are the ones that look best.
--
-- WHAT HONEST LINE SHOPPING IS WORTH, measured rather than assumed. Best against
-- median across the bettable panel inside ONE snapshot, so no staleness can
-- enter: h2h +4.01%, BTTS +3.58%, totals +3.44% on average, p95 around +8%.
-- That premium is REAL — a subscriber holding those accounts genuinely gets it,
-- and capturing it is the product working. So the test cannot be "premium above
-- some threshold is disqualifying"; best-of-nine-books is supposed to beat the
-- median by ~3.5%.
--
-- THE CLEAN TEST IS TAKEABILITY, NOT PREMIUM. Was this exact price at or below
-- the best price any bettable book was showing at the time? A premium over the
-- median can be honest. A price above the contemporaneous MAXIMUM cannot be.
--
-- Restricting to takeable rows changes the verdict on two of three:
--
--     architecture      market   takeable   no-vig CLV   z
--     DIXON_COLES       totals    62/133      -2.25%   -3.27
--     DIXON_COLES       btts      23/54       +1.10%   +0.74
--     MARKET_ANCHORED   h2h       88/103      +3.17%   +6.27
--
-- DIXON_COLES totals is not merely unproven, it is NEGATIVE and significantly
-- so once you count only bets that could have been placed. MARKET_ANCHORED
-- barely moves (+3.37% to +3.17%), because only 15% of its rows were
-- unavailable — its edge survives the correction.
--
-- ONE DEFINITION, TWO TABLES. `price_was_takeable()` is the only place the
-- question is answered, so the live ledger and the paper harness cannot drift
-- into two notions of "available", which is the failure mode this codebase has
-- shipped repeatedly.
--
-- LIMIT OF THE MEASURE, STATED HERE SO NOBODY OVER-READS IT: it is only as
-- precise as the odds feed is dense. The feed writes in bursts covering 10-23
-- fixtures an hour and the freshest quote on the forward card is ~64 minutes
-- old, so a window may catch some books and miss others. Treat a low takeable
-- share as a strong signal and a high one as weak evidence of health.

begin;

-- Was `p_price` at or below the best price any BETTABLE book was showing for
-- this selection around `p_at`? Null when no book quoted it in the window at
-- all — unknown, which is not the same as unavailable.
create or replace function public.price_was_takeable(
  p_match_id uuid,
  p_market text,
  p_market_line numeric,
  p_selection text,
  p_at timestamptz,
  p_price numeric,
  p_window interval default interval '30 minutes'
)
returns boolean
language sql
stable
set search_path to 'public', 'pg_catalog'
as $$
  select case when max(px) is null then null
              -- 0.1% tolerance: numeric(6,3) storage and a price that ticked
              -- back within the window are not evidence of a phantom quote.
              else p_price <= max(px) * 1.001 end
  from (
    select case
             when p_selection in ('home', 'over', 'btts_yes') then o.home_odds
             when p_selection = 'draw'                        then o.draw_odds
             else o.away_odds
           end as px
    from public.odds o
    where o.match_id = p_match_id
      and coalesce(o.market, 'h2h') = coalesce(p_market, 'h2h')
      and coalesce(o.market_line, -1) = coalesce(p_market_line, -1)
      and o.fetched_at between p_at - p_window and p_at + p_window
      and o.bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                                   'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  ) q
  where px > 1;
$$;

comment on function public.price_was_takeable is
  'Was this exact price at or below the best a bettable book was showing at the time? Null = no book quoted in the window (unknown, not unavailable). The ONE definition of an available price; see migration 066.';

-- ── The live ledger's liveness report ───────────────────────────────────────

create or replace view public.signal_price_liveness
with (security_invoker = on) as
with q as (
  select vs.model_architecture, coalesce(vs.market, 'h2h') as market, vs.no_vig_clv,
         public.price_was_takeable(vs.match_id, vs.market, vs.market_line,
                                   vs.outcome, vs.detected_at, vs.detected_odds) as takeable
  from public.value_signals vs
  where vs.result in ('win', 'loss') and vs.no_vig_clv is not null
)
select
  model_architecture,
  market,
  count(*)                                              as settled,
  count(*) filter (where takeable is not null)          as checkable,
  count(*) filter (where takeable)                      as takeable,
  round(100.0 * count(*) filter (where takeable)
        / nullif(count(*) filter (where takeable is not null), 0), 1) as takeable_pct,
  -- The headline, over everything.
  round(100 * avg(no_vig_clv), 2)                       as clv_all_pct,
  -- The one that counts: bets that could actually have been placed.
  round(100 * avg(no_vig_clv) filter (where takeable), 2) as clv_takeable_pct,
  round((avg(no_vig_clv) filter (where takeable)
        / nullif(stddev(no_vig_clv) filter (where takeable)
        / sqrt(nullif(count(*) filter (where takeable), 0)), 0))::numeric, 2) as z_takeable,
  -- The inflation being removed. Positive means the unavailable rows flattered
  -- the headline, which is the direction it always goes.
  round(100 * (avg(no_vig_clv) filter (where takeable is false)
             - avg(no_vig_clv) filter (where takeable)), 2) as phantom_inflation_pct
from q
group by 1, 2;

comment on view public.signal_price_liveness is
  'Splits settled CLV by whether the detected price was actually available. The unavailable rows carry the highest CLV, so a headline that includes them measures stale-quote capture. Judge on clv_takeable_pct. See migration 066.';

revoke all on public.signal_price_liveness from anon, authenticated;

commit;
