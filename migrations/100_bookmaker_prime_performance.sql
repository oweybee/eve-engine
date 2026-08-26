
-- 100 — bookmaker_prime_performance(): how each book has performed as the
-- SUPPLIER of a backed signal. Members only.
--
-- WHY A FUNCTION AND NOT A VIEW. A security_invoker view over value_signals
-- would inherit that table's tier RLS and technically work — but a free user
-- would then receive an aggregate computed over the handful of preview rows
-- they can see, which looks like a real bookmaker table and is not one. A
-- definer function that returns ZERO ROWS below the tier line cannot be
-- misread. The gate is `current_tier() <> 'free'`, the same predicate
-- value_signals already uses.
--
-- WHAT THIS MEASURES, AND WHAT IT DOES NOT. Each row is "signals where THIS
-- book held the price we flagged". A book can top the table by being loose
-- rather than by being beatable, and the two look identical here. avg_odds is
-- included precisely so that can be read: a book whose in-band average price is
-- far above the field is being selected for outlier pricing, not for weakness.
-- Sample sizes are small — `sample_ok` is false below 20 settled signals and
-- the UI must not print a headline yield for those rows.

begin;

create or replace function public.bookmaker_prime_performance(
  p_window_days int default 90
)
returns table (
  bookmaker      text,
  n              int,
  fixtures       int,
  wins           int,
  strike         numeric,
  avg_odds       numeric,
  avg_edge       numeric,
  yield          numeric,
  units          numeric,
  avg_no_vig_clv numeric,
  clv_n          int,
  prime_n        int,
  prime_units    numeric,
  edge_n         int,
  edge_units     numeric,
  sample_ok      boolean
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  with gate as (select (select public.current_tier()) <> 'free' as ok),
  s as (
    select v.bookmaker, v.match_id, v.detected_odds, v.detected_edge, v.no_vig_clv, v.result,
           case when v.result = 'win' then v.detected_odds - 1 else -1 end as pl,
           v.detected_edge >= 0.05 and v.detected_edge < 0.07 as is_prime
      from public.value_signals v, gate
     where gate.ok
       and v.result in ('win','loss')
       and v.bookmaker is not null
       and v.detected_at >= (now() at time zone 'utc') - make_interval(days => p_window_days)
       and v.detected_odds >= 1.40 and v.detected_odds < 3.00
       and v.detected_edge >= 0.05 and v.detected_edge < 0.10
  )
  select
    s.bookmaker,
    count(*)::int,
    count(distinct s.match_id)::int,
    count(*) filter (where s.result = 'win')::int,
    round(count(*) filter (where s.result = 'win')::numeric / count(*), 4),
    round(avg(s.detected_odds), 3),
    round(avg(s.detected_edge), 5),
    round(avg(s.pl), 5),
    round(sum(s.pl), 3),
    round(avg(s.no_vig_clv), 5),
    count(s.no_vig_clv)::int,
    count(*) filter (where s.is_prime)::int,
    round(coalesce(sum(s.pl) filter (where s.is_prime), 0), 3),
    count(*) filter (where not s.is_prime)::int,
    round(coalesce(sum(s.pl) filter (where not s.is_prime), 0), 3),
    count(*) >= 20
  from s
  group by s.bookmaker
  order by count(*) desc, sum(s.pl) desc;
$function$;

comment on function public.bookmaker_prime_performance(int) is
  'Per-bookmaker performance as the supplier of a backed signal (odds 1.40-3.00, edge 5-10%). '
  'MEMBERS ONLY — returns zero rows when current_tier() is free. sample_ok is false below 20 '
  'settled signals; do not print a headline yield for those rows. Measures which book held the '
  'outlier price, which is not the same as which book is beatable — read avg_odds alongside.';

grant execute on function public.bookmaker_prime_performance(int) to authenticated;
revoke execute on function public.bookmaker_prime_performance(int) from anon;

commit;
