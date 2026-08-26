
-- 101 — the tier gate on bookmaker_prime_performance() locked out the server too.
--
-- 100's gate is `current_tier() <> 'free'`, and current_tier() reads
-- auth.uid(). A service-key caller has no auth.uid(), so it resolved to 'free'
-- and the function returned zero rows to the ENGINE as well as to a free user.
-- That is the correct answer for a browser and the wrong one for a server
-- rendering the members page, so the gate now also passes for service_role.

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
  with gate as (
    select coalesce(auth.role(), current_user) in ('service_role', 'postgres', 'supabase_admin')
        or (select public.current_tier()) <> 'free'
        as ok
  ),
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

grant execute on function public.bookmaker_prime_performance(int) to authenticated;
revoke execute on function public.bookmaker_prime_performance(int) from anon;

commit;
