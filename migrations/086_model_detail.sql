-- 086_model_detail.sql — one architecture's record, broken down, readable by anon.
--
-- WHAT THIS IS FOR. `/models/<id>` is the detail view behind the directory
-- migration 085 made possible. 085 answers "what is this architecture's
-- record"; this one answers the questions a reader asks NEXT, and every one of
-- them turned out to change the reading of the headline:
--
--   • WHICH MARKETS. DIXON_COLES's -9.74% clustered yield is one number over
--     two sheets that do not agree: totals is +0.93% over 112 fixtures
--     (z 0.14) and BTTS is -14.58% over 72 (z -1.25). The directory card
--     cannot show that and the blend hides it.
--   • WHEN. The publication ruling cites +7.6% over 77 settled. The monthly
--     series is +12.89% (11 fixtures, June), +21.91% (16, July),
--     -15.69% (125, August) — so the ruling was made on the two good months
--     and 83% of the record has landed since.
--   • HOW OFTEN IT BEAT THE CLOSE. MARKET_ANCHORED beats the de-vigged close
--     on 87 of 103 measured settled selections (84.5%), which is what a TIMING
--     edge looks like; API_PREDICTIVE manages 19.1%. The mean CLV alone does
--     not separate "usually right by a little" from "occasionally right by a
--     lot", and this product has already ruled that the closing line is the
--     thing to judge on.
--   • WHETHER ITS SCORES SURVIVE THE WRITE LAYER. This is the one nobody could
--     see. `trg_score_needs_measured_sigma` and migration 060's overround
--     guard strip `mxs` from a row that cannot evidence it, and record why in
--     `score_withheld_reason`. Measured 21 Aug 2026, DIXON_COLES — the only
--     architecture that earned publication on a MEASURED record — wrote 170
--     signals in fourteen days and 20 of them carry a score. 125 were stripped
--     because its own de-vigged fair line came out ABOVE the price it was
--     taken from, which is not a market that existed. That is a live defect in
--     the publishing model and no surface in the product reports it.
--
-- WHY A FUNCTION, AND WHY DEFINER. Same reasoning as 085, unchanged:
-- `tiered_read_value_signals` (047) caps that table at FIVE ROWS for a free or
-- logged-out reader, so a browser computing these figures would compute them
-- off five rows and print them as the model's record. Migration 059 set the
-- rule `security_invoker = on` WITHOUT EXCEPTION for views, and a definer view
-- is precisely the hole it closed — so this is a FUNCTION, the pattern
-- `current_tier()`, `preview_match_ids()` and `model_record()` already use.
--
-- WHAT IT DISCLOSES. SETTLED ROWS ONLY. There is no way to reach a pending row
-- through it: every branch filters `result in ('win','loss')` except the score
-- census, which counts rows and their withheld reasons and returns no price,
-- no selection and no match. Settled history is not gated anywhere in this
-- product by standing rule — `match_results` is `USING (true)` over 77,438
-- rows INCLUDING closing prices, and `performance_summary` already publishes
-- the headline yield to anon. Only a PENDING claim is an offer.
--
-- `settled_recent` is the one place a per-row shape leaves this function: the
-- last 20 SETTLED selections with their kickoff, market, outcome, the price
-- they were taken at, whether they won and their de-vigged CLV. Those are
-- historical facts about bets that are over. The OPEN book is not here and is
-- not meant to be — `/models/<id>` reads pending signals through the ordinary
-- browser client so RLS 047 applies to them exactly as it does everywhere
-- else, and a free reader gets the five-row preview and a padlock.
--
-- `outcome` IS THE SELECTION AND `signal_label` IS NOT. The first draft of this
-- function returned `coalesce(signal_label, outcome)`, which mixed two
-- vocabularies in one column: `signal_label` holds a TRIGGER name ('Market
-- Steamer', 'Sharp Contrarian Edge') on some rows and null on others, so the
-- list read 'btts_no', 'over', 'Market Steamer' down one column as though
-- those were three selections. `outcome` alone is the selection and its
-- vocabulary is closed: over / under / btts_yes / btts_no / home / draw / away.
--
-- ARGUMENT SAFETY. `p_arch` is a bare text equality against a coalesced
-- column; it is never concatenated into SQL, and an unknown name returns a
-- fully-shaped object with zeroes rather than null, so the page's "this model
-- has written nothing" state is reachable and distinguishable from a failed
-- read. `search_path` is pinned, as every definer function here is.
--
-- TO REVERT: drop function public.model_detail(text);

create or replace function public.model_detail(p_arch text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  with mine as (
    select vs.*
      from public.value_signals vs
     where coalesce(vs.model_architecture, '(unrecorded)') = p_arch
  ),
  settled as (select * from mine where result in ('win', 'loss')),
  -- CLUSTERED BY FIXTURE, like every other yield in this product: the engine
  -- writes several signals per match and their outcomes share one result, so
  -- the unit of independence is the MATCH and not the signal.
  per_fx as (
    select market, match_id,
           avg(case when result = 'win' then detected_odds - 1 else -1 end) as r
      from settled group by 1, 2
  ),
  by_market as (
    select market, count(*)::int as n_fx, avg(r) as mu, stddev_samp(r) as sd
      from per_fx group by 1
  ),
  sig_market as (select market, count(*)::int as n from settled group by 1),
  per_month as (
    select date_trunc('month', detected_at)::date as m, match_id,
           avg(case when result = 'win' then detected_odds - 1 else -1 end) as r
      from settled group by 1, 2
  ),
  by_month as (select m, count(*)::int as n_fx, avg(r) as mu from per_month group by 1),
  -- THE REASONS ARE PER-ROW PROSE AND MUST BE BUCKETED. Each carries the row's
  -- own arithmetic ('market_prob x detected_odds = 1.0284'), so grouping the
  -- raw column returns one bucket per row and says nothing. These three
  -- families are what the write-layer guards actually emit.
  withheld as (
    select case
             when score_withheld_reason like '%no row in model_calibration%'
               then 'no calibration row, so no measured error bar'
             when score_withheld_reason like '%24h of price history%'
               then 'de-vigged from price history, not a line that was quoted'
             when score_withheld_reason like '%above 1%'
               then 'the de-vigged fair line beat the price it came from'
             else 'other'
           end as fam,
           count(*)::int as n
      from mine where score_withheld_reason is not null group by 1
  )
  select jsonb_build_object(
    'architecture', p_arch,
    'markets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'market', b.market,
        'fixtures', b.n_fx,
        'signals', (select n from sig_market s where s.market = b.market),
        'yield_clustered', round(b.mu::numeric, 4),
        'yield_z', case when b.n_fx >= 2 and b.sd > 0
                        then round((b.mu / (b.sd / sqrt(b.n_fx)))::numeric, 2) end
      ) order by b.n_fx desc) from by_market b), '[]'::jsonb),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'fixtures', n_fx,
        'yield_clustered', round(mu::numeric, 4)
      ) order by m) from by_month), '[]'::jsonb),
    -- BOTH CLV MEASURES, AND THE DENOMINATOR. They are not interchangeable —
    -- `avg_clv` is measured against the closing PRICE with the margin still in
    -- it, `avg_no_vig_clv` against the Shin-de-vigged fair close, and three
    -- architectures have a positive raw figure and a negative de-vigged one.
    -- `with_clv` is reported because the close is written after kickoff, so
    -- the most recent settled week runs well under full coverage (40 of 95 on
    -- 21 Aug) and a mean quoted without its denominator hides that.
    'clv', (select jsonb_build_object(
      'settled', count(*)::int,
      'with_clv', count(no_vig_clv)::int,
      'beat_close', (count(*) filter (where no_vig_clv > 0))::int,
      'avg_clv', round(avg(clv)::numeric, 4),
      'avg_no_vig_clv', round(avg(no_vig_clv)::numeric, 4)
    ) from settled),
    'book', (select jsonb_build_object(
      'wins', (count(*) filter (where result = 'win'))::int,
      'losses', (count(*) filter (where result = 'loss'))::int,
      'avg_odds', round(avg(detected_odds)::numeric, 2)
    ) from settled),
    'scores', (select jsonb_build_object(
      'written', count(*)::int,
      'scored', count(mxs)::int,
      'written_recent', (count(*) filter (where detected_at > now() - interval '14 days'))::int,
      'scored_recent', (count(mxs) filter (where detected_at > now() - interval '14 days'))::int,
      'reasons', coalesce((
        select jsonb_agg(jsonb_build_object('reason', fam, 'signals', n) order by n desc)
          from withheld), '[]'::jsonb)
    ) from mine),
    'settled_recent', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'kickoff_at', s.kickoff_at,
        'market', s.market,
        'outcome', s.outcome,
        'odds', s.detected_odds,
        'result', s.result,
        'no_vig_clv', s.no_vig_clv,
        'home', ht.name,
        'away', at.name
      ) as x
        from settled s
        left join public.matches m  on m.id  = s.match_id
        left join public.teams   ht on ht.id = m.home_team_id
        left join public.teams   at on at.id = m.away_team_id
       order by s.kickoff_at desc nulls last
       limit 20
    ) q), '[]'::jsonb)
  );
$$;

comment on function public.model_detail(text) is
  'One architecture''s SETTLED record broken down by market and by month, its '
  'closing-line agreement with both denominators, its write-layer score census '
  'and its last 20 settled selections. Definer because RLS 047 caps '
  'value_signals at five rows for a free reader. No pending row is reachable '
  'through it.';

revoke all on function public.model_detail(text) from public;
grant execute on function public.model_detail(text) to anon, authenticated;

-- ── ASSERTED, NOT EYEBALLED ────────────────────────────────────────────────
-- 085 asserts its own behaviour from the anon seat before committing and this
-- does the same. Two properties matter: the aggregate must see the whole book
-- where anon's own read of value_signals sees five rows, and it must be
-- IMPOSSIBLE to reach a pending row through it.
do $$
declare
  v jsonb;
  v_anon_rows int;
  v_settled int;
  v_pending_leak int;
begin
  set local role anon;

  select count(*) into v_anon_rows from public.value_signals;
  v := public.model_detail('DIXON_COLES');
  v_settled := (v -> 'clv' ->> 'settled')::int;

  if v_settled <= v_anon_rows then
    raise exception
      'model_detail() is capped like the table it reads: % settled through the aggregate, % rows visible directly',
      v_settled, v_anon_rows;
  end if;

  -- The settled list must contain no row whose result is anything but win/loss.
  select count(*) into v_pending_leak
    from jsonb_array_elements(v -> 'settled_recent') e
   where e ->> 'result' not in ('win', 'loss');
  if v_pending_leak > 0 then
    raise exception 'model_detail() leaked % non-settled selections', v_pending_leak;
  end if;

  -- An unknown architecture must return a SHAPE, not null: the page's
  -- "written nothing" state has to be distinguishable from a failed read.
  v := public.model_detail('NO_SUCH_ARCHITECTURE');
  if v is null or (v -> 'clv' ->> 'settled')::int <> 0 then
    raise exception 'model_detail() does not fail closed on an unknown architecture';
  end if;

  reset role;
end $$;
