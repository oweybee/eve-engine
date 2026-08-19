-- 065_paper_gate_measures_no_vig_clv.sql
--
-- THE GATE WAS MEASURING THE FLATTERING NUMBER.
--
-- `paper_trade_gate()` is the only thing standing between a model and the
-- published board: 300 settled trades, CLV above the bar, z above 2. The
-- consolidation plan hangs its entire Phase 2 on it — four weeks of live slate
-- accrual whose sole output is a pass or a fail.
--
-- It averaged `paper_trades.clv`, and `settle_paper_trade()` computed that as
--
--     clv = price_taken / closing_price - 1
--
-- against the closing PRICE, with the bookmaker's margin still in it. Beating a
-- price that carries margin is not hard; it is roughly what you get for showing
-- up. `paper_trades.no_vig_clv` has existed as a column all along and NOTHING
-- HAS EVER WRITTEN IT.
--
-- How much that matters, measured on the live book the same day:
--
--     architecture        no-vig CLV      vig-inclusive CLV
--     MARKET_CONSENSUS      -3.98%             +9.00%
--     LAMBDA_MC             -3.58%             +1.91%
--     API_PREDICTIVE        -3.26%             +3.26%*
--
-- MARKET_CONSENSUS is the worst architecture this platform has ever run — it is
-- being switched off in the same change — and on the measure the gate was using
-- it reads +9.00%. It would have passed. A gate that certifies the model you
-- are deleting is not a gate.
--
-- (*API_PREDICTIVE reads +1.50% vig-inclusive; the three-column point stands.)
--
-- TWO CHANGES.
--
-- 1. `settle_paper_trade()` reads `closing_lines` — the same benchmark
--    `value_signals` uses since migration 061, quoted STRICTLY before kickoff
--    and Shin-de-vigged — and writes BOTH numbers. `clv` keeps its meaning so
--    nothing that reads it breaks; `no_vig_clv` is the new one and is the one
--    that counts. The caller may still pass a closing price explicitly, which
--    wins over the table, because the harness has to stay drivable from a
--    backtest that has its own closes.
--
--    It also switches to the LOG form, `ln(taken / close)`, so paper CLV and
--    live CLV are the same quantity. The ratio form and the log form disagree
--    by ~0.5pp at a 10% move, which is the width of the bar itself.
--
-- 2. `paper_trade_gate()` evaluates `no_vig_clv`, and its default bar goes back
--    to +0.5%. The consolidation plan specifies `paper_trade_gate(300, 0.0, 2.0)`
--    — zero — in a document whose own risk section says "the correct response is
--    to stop, not to lower the gate". The platform's standing rule is CLV above
--    +0.5%, and this restores it as the DEFAULT so passing zero has to be typed
--    deliberately rather than inherited.
--
-- A trade with no closing line gets NULL CLV and is excluded from the CLV
-- average and the z, but still counts toward settled `n`. That is deliberate:
-- the sample size is honest about how many bets were placed, and the CLV is
-- honest about how many could be measured.

begin;

create or replace function public.settle_paper_trade(
  p_id uuid,
  p_closing_price numeric,
  p_actual_value numeric,
  p_closing_avg numeric default null::numeric
)
returns void
language plpgsql
set search_path to 'public', 'pg_catalog'
as $function$
declare
  r public.paper_trades;
  won boolean;
  v_close numeric;
  v_fair  numeric;
begin
  select * into r from public.paper_trades where id = p_id;
  if not found then raise exception 'paper_trade % not found', p_id; end if;

  if r.selection = 'over' then won := p_actual_value > r.market_line;
  elsif r.selection = 'under' then won := p_actual_value < r.market_line;
  else won := p_actual_value >= 1; end if;

  -- The benchmark. An explicitly supplied close wins — a backtest brings its
  -- own — otherwise take the frozen pre-kickoff vector from `closing_lines`.
  select cl.closing_odds, cl.no_vig_odds into v_close, v_fair
  from public.closing_lines cl
  where cl.match_id  = r.match_id
    and cl.market    = coalesce(r.market, 'h2h')
    and cl.selection = r.selection
    and coalesce(cl.market_line, -1) = coalesce(r.market_line, -1)
  limit 1;

  v_close := coalesce(p_closing_price, v_close);

  update public.paper_trades
  set closing_price = v_close,
      closing_avg   = coalesce(p_closing_avg, closing_avg),
      -- vs the closing PRICE, margin still in it. Kept for continuity; it is
      -- not what the gate reads.
      clv = case when v_close > 1 and price_taken > 1
                 then round(ln(price_taken / v_close), 4) end,
      -- vs the Shin-de-vigged FAIR close. THIS is the gate's measure.
      no_vig_clv = case when v_fair > 1 and price_taken > 1
                        then round(ln(price_taken / v_fair), 4) end,
      result = case when won then 'win' else 'loss' end,
      actual_value = p_actual_value,
      pl_units = case when won then price_taken - 1 else -1 end,
      settled_at = now()
  where id = p_id;
end;
$function$;

create or replace function public.paper_trade_gate(
  p_min_n integer default 300,
  p_min_clv numeric default 0.005,
  p_min_clv_zscore numeric default 2.0
)
returns table(model text, market text, settled integer, avg_clv_pct numeric,
              clv_zscore numeric, yield_pct numeric, verdict text)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with s as (
    select pt.model, pt.market,
      count(*) filter (where pt.result in ('win','loss')) as n,
      -- NO-VIG. Beating a price with the bookmaker's margin in it is not
      -- evidence of anything; see migration 065.
      avg(pt.no_vig_clv) as clv,
      stddev(pt.no_vig_clv)::numeric as clv_sd,
      count(pt.no_vig_clv) as n_clv,
      sum(pt.pl_units) as pl
    from public.paper_trades pt group by pt.model, pt.market),
  z as (
    select s.*, s.clv / nullif(s.clv_sd / sqrt(nullif(s.n_clv, 0))::numeric, 0) as zscore from s)
  select z.model, z.market, z.n::int, round(100 * z.clv, 2), round(z.zscore, 2),
    round(100 * z.pl / nullif(z.n, 0), 2),
    case
      when z.n < p_min_n
        then format('HOLD — %s settled, needs %s', z.n, p_min_n)
      when z.n_clv = 0
        then 'HOLD — no closing line on any settled trade, CLV unmeasurable'
      when z.clv < p_min_clv
        then format('FAIL — no-vig CLV %s%% below the %s%% bar', round(100 * z.clv, 2), round(100 * p_min_clv, 2))
      when z.zscore is null or z.zscore < p_min_clv_zscore
        then format('FAIL — CLV z %s below %s', coalesce(round(z.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      else 'PASS'
    end
  from z order by z.model, z.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric) is
  'The publication gate. Evaluates NO-VIG CLV (vs the Shin-de-vigged close in closing_lines), never the vig-inclusive number — on the live book those two read -3.98% and +9.00% for the same architecture. Default bar is the platform standard: n>=300, no-vig CLV >= +0.5%, z >= 2.';

commit;
