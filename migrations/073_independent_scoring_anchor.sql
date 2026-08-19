-- 073_independent_scoring_anchor.sql
--
-- A BENCHMARK THAT DID NOT PICK THE BET.
--
-- `closing_lines` freezes Pinnacle's own Shin-de-vigged close, and the platform
-- rules that Shin-de-vigged Pinnacle IS fair value. That is exactly why it
-- cannot score MARKET_ANCHORED. That architecture selects the outcome whose best
-- bettable price most exceeds Pinnacle's Shin-de-vigged fair line, and
-- `no_vig_clv` then scored that same price against Pinnacle's Shin-de-vigged
-- CLOSING line. Same books, same de-vig, same line — two timestamps. The
-- identity `no_vig_clv = ln(detected_odds / no_vig_odds)` holds to 5e-5, so CLV
-- splits exactly, and over 89 settled fixtures it split like this:
--
--     no-vig CLV            +3.475%
--     edge at detection     +3.844%   <- the selection threshold, restated
--     anchor line movement  -0.369%   (z -0.91)
--
-- The gate's headline metric was the selection rule measured against itself,
-- and it could not have failed. This table is the benchmark that can fail it.
--
-- WHAT IT HOLDS. Per fixture, the last price vector quoted STRICTLY before
-- kickoff, taken as the MEDIAN across the bettable panel with PINNACLE EXCLUDED,
-- then Shin-de-vigged. Same pre-kickoff enforcement as `closing_lines`: the
-- CHECK is on the row, and a quote more than 12h stale is not a close.
--
-- STORED ALONGSIDE, NEVER INSTEAD OF. `closing_lines` is untouched and still
-- written by captureClosingLines.js. Both are wanted: the Pinnacle anchor is
-- the sharper benchmark and is correct for any model that does not select
-- against it, and comparing the two is how the tautology was found.
--
-- A MEDIAN, NOT A BEST PRICE. The benchmark must be what the market believed,
-- not what the luckiest book showed. A max-of-panel close would bake the
-- line-shopping premium into the benchmark and read every CLV low.
--
-- FIVE BOOKS MINIMUM. Below that a median is one or two prices wearing a
-- consensus's clothes. Measured over the last 30 days, 635 h2h fixtures clear
-- it against Pinnacle's 705, 615 BTTS and 610 totals — the floor costs almost
-- no coverage.
--
-- IT IS INDEPENDENT OF THE PRICE, NOT OF THE CAUSAL CHAIN. What survives on
-- MARKET_ANCHORED once this benchmark is used is the soft panel converging
-- toward Pinnacle between detection and close. Pinnacle is out of the
-- benchmark; it is still the reason the benchmark moves. See
-- docs/ANCHOR_INDEPENDENCE.md before quoting the number.
--
-- The backfill below is a ONE-OFF. captureIndependentLines.js is the only
-- ongoing writer, and it de-vigs through lib/devig.js — the single Shin
-- implementation. The bisection here was verified against that module on real
-- 2- and 3-outcome vectors: max |z| difference 1.5e-10, max |p| difference
-- 6.3e-11, and every de-vigged vector sums to 1.000000000.

create table if not exists closing_lines_independent (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references matches(id) on delete cascade,
  market        text not null,
  market_line   numeric,
  selection     text not null,
  closing_odds  numeric not null,
  no_vig_prob   numeric not null,
  no_vig_odds   numeric not null,
  book_count    integer not null,
  books         text[]  not null,
  overround     numeric not null,
  kickoff_at    timestamptz not null,
  quoted_at     timestamptz not null,
  captured_at   timestamptz not null default now(),
  constraint closing_lines_independent_prekickoff check (quoted_at <= kickoff_at),
  constraint closing_lines_independent_books      check (book_count >= 5),
  constraint closing_lines_independent_prob       check (no_vig_prob > 0 and no_vig_prob < 1)
);

create unique index if not exists closing_lines_independent_unique
  on closing_lines_independent (match_id, market, coalesce(market_line, (-1)::numeric), selection);
create index if not exists closing_lines_independent_match_idx on closing_lines_independent (match_id);

comment on table closing_lines_independent is
  'The INDEPENDENT scoring anchor: median pre-kickoff closing price across the bettable panel with PINNACLE EXCLUDED, Shin-de-vigged. Exists so a model whose selection rule optimises against Pinnacle''s de-vigged line can be scored against something that rule never referenced. Stored ALONGSIDE closing_lines, never replacing it.';

alter table closing_lines_independent enable row level security;
drop policy if exists closing_lines_independent_read on closing_lines_independent;
create policy closing_lines_independent_read on closing_lines_independent for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on closing_lines_independent from anon, authenticated;

-- ── ONE-OFF BACKFILL ────────────────────────────────────────────────────────
-- Latest quote per book per (fixture, market, line), strictly pre-kickoff and
-- within the 12h staleness window, complete vectors only, minimum 5 books,
-- median per leg, then Shin by bisection (60 halvings; the tolerance is reached
-- long before). Mirrors captureIndependentLines.js exactly.
create temporary table ind_stage on commit drop as
with bettable as (
  select unnest(array['bet365','williamhill','betvictor','unibet_uk','betfair_sb_uk',
                      'paddypower','skybet','betano','10bet','dafabet','sbo','marathonbet']) b),
latest as (
  select distinct on (o.match_id, o.market, coalesce(o.market_line,(-1)::numeric), o.bookmaker)
         o.match_id, o.market, o.market_line, o.bookmaker,
         o.home_odds::float ho, o.draw_odds::float dro, o.away_odds::float ao,
         o.fetched_at, m.kickoff_at
  from odds o join matches m on m.id = o.match_id
  where o.fetched_at <= m.kickoff_at
    and o.fetched_at >= m.kickoff_at - interval '12 hours'
    and m.kickoff_at < now()
    and o.market in ('h2h','totals','btts')
    and o.bookmaker in (select b from bettable)
  order by o.match_id, o.market, coalesce(o.market_line,(-1)::numeric), o.bookmaker, o.fetched_at desc),
complete as (
  -- A book contributes to EVERY leg or to none: a per-leg median over different
  -- book sets silently changes which market the benchmark describes.
  select * from latest where ho > 1 and ao > 1 and (market <> 'h2h' or dro > 1))
select match_id, market, market_line, kickoff_at,
       count(*)::int book_count,
       array_agg(bookmaker order by bookmaker) books,
       max(fetched_at) quoted_at,
       percentile_cont(0.5) within group (order by ho) p1,
       case when market='h2h' then percentile_cont(0.5) within group (order by dro) end p2,
       percentile_cont(0.5) within group (order by ao) p3
from complete
group by match_id, market, market_line, kickoff_at
having count(*) >= 5;

create temporary table ind_shin on commit drop as
with recursive base as (
  select match_id, market, market_line, kickoff_at, book_count, books, quoted_at,
         case when market='h2h' then array[p1,p2,p3] else array[p1,p3] end as prices
  from ind_stage),
v as (select b.*, (select array_agg(1/x) from unnest(b.prices) x) pi,
                  (select sum(1/x) from unnest(b.prices) x) orr
      from base b),
rec as (
  -- A vector with no margin left is not a market. Shin normalises such a vector
  -- and flags it; a benchmark built from one reports CLV against a price nobody
  -- quoted, so it is dropped rather than de-vigged.
  select match_id, market, market_line, kickoff_at, book_count, books, quoted_at, prices, pi, orr,
         0::double precision lo, (1-1e-12)::double precision hi, 0 it
  from v where orr > 1 + 1e-12),
bis as (
  select * from rec
  union all
  select r.match_id, r.market, r.market_line, r.kickoff_at, r.book_count, r.books, r.quoted_at,
         r.prices, r.pi, r.orr,
    case when f.s > 1 then (r.lo+r.hi)/2 else r.lo end,
    case when f.s > 1 then r.hi else (r.lo+r.hi)/2 end,
    r.it + 1
  from bis r
  cross join lateral (select (r.lo+r.hi)/2 as z) m
  cross join lateral (select sum((sqrt(greatest(m.z*m.z + 4*(1-m.z)*x*x/r.orr, 0)) - m.z)/(2*(1-m.z))) s
                      from unnest(r.pi) x) f
  where r.it < 60)
select match_id, market, market_line, kickoff_at, book_count, books, quoted_at, prices, orr,
       (select array_agg((sqrt(greatest(((lo+hi)/2)^2 + 4*(1-(lo+hi)/2)*x*x/orr,0)) - (lo+hi)/2)/(2*(1-(lo+hi)/2)))
        from unnest(pi) x) probs
from bis where it = 60;

insert into closing_lines_independent
  (match_id, market, market_line, selection, closing_odds, no_vig_prob, no_vig_odds,
   book_count, books, overround, kickoff_at, quoted_at)
select s.match_id, s.market, s.market_line,
  (case s.market when 'h2h'    then (array['home','draw','away'])[i]
                 when 'totals' then (array['over','under'])[i]
                 else               (array['btts_yes','btts_no'])[i] end),
  round(s.prices[i]::numeric, 4),
  round(s.probs[i]::numeric, 6),
  round((1/s.probs[i])::numeric, 4),
  s.book_count, s.books, round(s.orr::numeric, 6), s.kickoff_at, s.quoted_at
from ind_shin s
cross join lateral generate_series(1, array_length(s.probs,1)) i
where s.probs[i] > 0 and s.probs[i] < 1
on conflict do nothing;

-- Applied and verified in production 19 Aug 2026: 4,355 rows over 635 h2h,
-- 615 btts and 610 totals fixtures; zero rows carry 'pinnacle' in `books`;
-- zero quotes after kickoff; average overround 1.075 h2h / 1.081 btts /
-- 1.066 totals — the panel median is a SOFTER line than Pinnacle's ~1.035,
-- which is the point and must be remembered when the two CLVs are compared.
