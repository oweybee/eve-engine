-- 062_backfill_closing_lines_and_clv.sql
--
-- SEED `closing_lines` FROM RETAINED ODDS HISTORY, THEN RE-MEASURE CLV.
--
-- Migration 061 created the table and `captureClosingLines.js` owns it going
-- forward. This is the one-off that fills it in for fixtures that have already
-- kicked off, so CLV exists TODAY rather than after a week of new fixtures.
--
-- IT IS RECOVERABLE, AND THAT IS WHY THIS BACKFILL IS ALLOWED. Migration 058
-- declined to rewrite `prob_gap` history because the sibling prices at each
-- historical detection were NOT reliably recoverable — only 94 of 377 rows
-- reproduced their own detected price — so a backfill would have injected noise
-- the size of the correction. The opposite is true here. `odds` retains every
-- quote back to 12 June, and of the fixtures that have kicked off, 667 have a
-- complete price vector quoted STRICTLY BEFORE kickoff: 659 of them Pinnacle's
-- own, at a mean overround of 1.0457. That is a real closing line, not a
-- reconstruction.
--
-- WHAT IT REPLACES. Every `clv` in this table was measured against
-- `odds_snapshots.snapshot_type = 'closing'`, a label `captureSnapshot.js`
-- applies from 60 minutes BEFORE kickoff to 180 minutes AFTER. 22,988 of the
-- 32,303 rows carrying it were captured after kickoff and the median one is 42
-- MINUTES INTO THE MATCH. And every `no_vig_clv` came from
-- `settle_match_signals()`, which used PROPORTIONAL de-vig — the method
-- lib/devig.js disqualified after it flagged 49 longshots for 1 winner and -70%
-- yield — over whichever single bookmaker row was fetched last, with no book
-- filter at all.
--
-- So the existing numbers are not noisy versions of CLV. They are a different
-- quantity wearing its name. WHERE THIS CANNOT PRODUCE A REAL CLOSING LINE THE
-- COLUMNS ARE SET TO NULL rather than left holding the old value: a wrong
-- number that reads as evidence is worse than an absent one, which is the same
-- ruling `score_withheld_reason` and the publication gate already make.
--
-- `public.shin_devig()` is used here rather than a second solver. It is the
-- hand-ported twin of lib/devig.js — the same arrangement dixonColes.js/.ts
-- uses — and was checked against it on three golden vectors before this ran,
-- agreeing to twelve decimal places.

begin;

-- ── 1+2. Build every closing vector, Shin-de-vig it, store it ───────────────
--
-- One statement on purpose. Temp tables and temp views have different
-- lifetimes inside a migration transaction, and a half-populated staging table
-- surviving a retry is a way to write a closing line twice.

insert into public.closing_lines
  (match_id, market, market_line, selection, closing_odds,
   no_vig_prob, no_vig_odds, basis, book_count, overround, kickoff_at, quoted_at)
with pre as (
  -- The latest quote per book, per market, per line — STRICTLY before kickoff
  -- and not a dead line. Taking a max over history instead is exactly the
  -- defect that made `bestTwoWay` de-vig a market that never existed.
  select distinct on (o.match_id, o.market, coalesce(o.market_line, -1), o.bookmaker)
    o.match_id, o.market, o.market_line, o.bookmaker,
    o.home_odds, o.draw_odds, o.away_odds, o.fetched_at, m.kickoff_at
  from public.odds o
  join public.matches m on m.id = o.match_id
  where m.kickoff_at < now()
    and o.fetched_at <= m.kickoff_at
    and o.fetched_at >= m.kickoff_at - interval '12 hours'
  order by o.match_id, o.market, coalesce(o.market_line, -1), o.bookmaker, o.fetched_at desc
),
-- The bettable panel, mirroring lib/marketAnchor.BETTABLE_BOOKS. Pinnacle is
-- absent because it is the anchor, not a member of the panel.
h as (
  select * from pre
  where market = 'h2h' and home_odds > 1 and draw_odds > 1 and away_odds > 1
),
t as (
  select * from pre
  where market in ('totals','btts') and home_odds > 1 and away_odds > 1
),
h_anchor as (
  select match_id, 'h2h'::text market, null::numeric market_line, kickoff_at,
         array[home_odds, draw_odds, away_odds]::float8[] prices,
         array['home','draw','away']::text[] sels,
         'anchor'::text basis, 1 book_count, fetched_at quoted_at
  from h where bookmaker = 'pinnacle'
),
h_cons as (
  select match_id, 'h2h'::text, null::numeric, kickoff_at,
         array[percentile_cont(0.5) within group (order by home_odds),
               percentile_cont(0.5) within group (order by draw_odds),
               percentile_cont(0.5) within group (order by away_odds)]::float8[],
         array['home','draw','away']::text[],
         'consensus'::text, count(*)::int, max(fetched_at)
  from h
  where bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                               'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  group by 1, 4 having count(*) >= 2
),
-- Engine convention: over/yes → home_odds, under/no → away_odds. The LINE is
-- part of the identity: a probability at one handicap priced against another
-- handicap's odds is the exact fabrication `bestTwoWay` was rewritten to stop.
t_anchor as (
  select match_id, market, market_line, kickoff_at,
         array[home_odds, away_odds]::float8[],
         case when market = 'totals' then array['over','under']::text[]
                                     else array['btts_yes','btts_no']::text[] end,
         'anchor'::text, 1, fetched_at
  from t where bookmaker = 'pinnacle'
),
t_cons as (
  select match_id, market, market_line, kickoff_at,
         array[percentile_cont(0.5) within group (order by home_odds),
               percentile_cont(0.5) within group (order by away_odds)]::float8[],
         case when market = 'totals' then array['over','under']::text[]
                                     else array['btts_yes','btts_no']::text[] end,
         'consensus'::text, count(*)::int, max(fetched_at)
  from t
  where bookmaker = any (array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                               'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet'])
  group by 1, 2, 3, 4 having count(*) >= 2
),
vec as (
  select * from h_anchor
  union all
  select c.* from h_cons c
    where not exists (select 1 from h_anchor a where a.match_id = c.match_id)
  union all
  select * from t_anchor
  union all
  select c.* from t_cons c
    where not exists (select 1 from t_anchor a
                      where a.match_id = c.match_id and a.market = c.market
                        and coalesce(a.market_line, -1) = coalesce(c.market_line, -1))
)
select
  v.match_id, v.market, v.market_line, v.sels[i],
  round(v.prices[i]::numeric, 4),
  round(d.probs[i]::numeric, 6),
  round((1 / d.probs[i])::numeric, 4),
  v.basis, v.book_count,
  round(d.orr::numeric, 6),
  v.kickoff_at, v.quoted_at
from vec v
cross join lateral (
  select public.shin_devig(v.prices) probs,
         (select sum(1 / x) from unnest(v.prices) x) orr
) d
cross join lateral generate_subscripts(v.prices, 1) i
-- A vector with no margin left is not a market. Same gate as `devigProbs` and
-- `bestTwoWay`: a benchmark built from one reports CLV against a price nobody
-- ever quoted.
where d.orr > 1
  and d.probs is not null
  and d.probs[i] > 0 and d.probs[i] < 1
  and v.prices[i] > 1
on conflict do nothing;

-- ── 3. Re-measure CLV on every signal ───────────────────────────────────────
--
-- CLV is undefined for an in-play signal — the line closed at kickoff, so a
-- pre-kickoff benchmark is not one. Those stay null, as they already did.
--
--   clv         = ln(detected / closing)      did the price beat the close
--   no_vig_clv  = ln(detected / fair close)   did it beat the close with the
--                                             bookmaker's margin taken out
--
-- The second is the harder and more honest measure, and it is the one
-- `paper_trade_gate()` should be opening the publication gate on.
update public.value_signals vs
set closing_odds = cl.closing_odds,
    clv          = round(ln(vs.detected_odds / cl.closing_odds), 4),
    no_vig_clv   = round(ln(vs.detected_odds / cl.no_vig_odds), 4)
from public.closing_lines cl
where cl.match_id = vs.match_id
  and cl.market   = coalesce(vs.market, 'h2h')
  and cl.selection = vs.outcome
  and coalesce(cl.market_line, -1) = coalesce(vs.market_line, -1)
  and coalesce(vs.phase, 'prematch') <> 'inplay'
  and vs.detected_odds > 1;

-- Anything this could not measure loses the old number. It was taken against a
-- post-kickoff price, or a proportional de-vig of one arbitrary book, and a
-- wrong number that reads as evidence is worse than an absent one.
update public.value_signals vs
set closing_odds = null, clv = null, no_vig_clv = null
where (vs.clv is not null or vs.no_vig_clv is not null or vs.closing_odds is not null)
  and not exists (
    select 1 from public.closing_lines cl
    where cl.match_id = vs.match_id
      and cl.market = coalesce(vs.market, 'h2h')
      and cl.selection = vs.outcome
      and coalesce(cl.market_line, -1) = coalesce(vs.market_line, -1));

-- `signal_label` is DERIVED from no_vig_clv by settle_match_signals(). Leaving
-- it standing on rows whose no_vig_clv just changed or vanished would leave a
-- word on the row that its own number no longer supports.
update public.value_signals
set signal_label = case
      when no_vig_clv is null   then null
      when no_vig_clv > 0       then 'Market Steamer'
      when result = 'win'       then 'Sharp Contrarian Edge'
      when result = 'loss'      then 'Market Confirmed'
    end
where result in ('win','loss') or signal_label is not null;

commit;
