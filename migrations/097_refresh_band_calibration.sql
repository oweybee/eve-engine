
-- 097 — refresh_band_calibration(): fills one dated snapshot of every band.
--
-- Called on a schedule. Idempotent for a given (as_of_date, window_days):
-- re-running overwrites that day's rows rather than accumulating duplicates.
--
-- THE Z IS CLUSTERED AND THAT IS NOT OPTIONAL. Up to fifteen signals can fire
-- on one fixture; treating them as fifteen independent bets shrinks the
-- standard error by roughly the square root of that and turns noise into a
-- result. CR0 by match_id, the same estimator the paper harness uses.

begin;

create or replace function public.refresh_band_calibration(
  p_window_days int default 90,
  p_as_of       date default null
)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'utc')::date);
  v_from  timestamptz := (now() at time zone 'utc') - make_interval(days => p_window_days);
  v_rows  int;
begin
  delete from public.band_calibration
   where as_of_date = v_as_of and window_days = p_window_days;

  with bands(band_key, band_label, edge_min, edge_max, odds_min, odds_max, backed) as (
    values
      -- MIRRORS lib/signalTier.js. Keep in step; see the table comment.
      ('prime',       'PRIME 5.0-6.9%',      0.050, 0.070, 1.40, 3.00, true),
      ('edge',        'EDGE 7.0-9.9%',       0.070, 0.100, 1.40, 3.00, true),
      ('below_floor', 'Below floor <5.0%',   0.020, 0.050, 1.40, 3.00, false),
      ('above_cap',   'Above cap >=10%',     0.100, 1.000, 1.40, 3.00, false),
      ('longshot',    'Longshot odds >=3.00',0.020, 1.000, 3.00, 1000.0, false)
  ),
  s as (
    select b.band_key, b.band_label, b.edge_min, b.edge_max, b.odds_min, b.odds_max, b.backed,
           v.match_id, v.detected_odds, v.detected_edge, v.no_vig_clv, v.result,
           case when v.result = 'win' then v.detected_odds - 1 else -1 end as pl
      from bands b
      join public.value_signals v
        on v.result in ('win','loss')
       and v.detected_at >= v_from
       and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
       and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max
  ),
  agg as (
    select band_key, band_label, edge_min, edge_max, odds_min, odds_max, backed,
           count(*)::int                             as n,
           count(distinct match_id)::int             as fixtures,
           count(*) filter (where result='win')::int as wins,
           avg(pl)                                   as mu,
           sum(pl)                                   as units,
           avg(detected_odds)                        as avg_odds,
           avg(detected_edge)                        as avg_edge,
           avg(no_vig_clv)                           as avg_clv,
           count(no_vig_clv)::int                    as clv_n
      from s group by 1,2,3,4,5,6,7
  ),
  clus as (   -- CR0: sum of squared within-fixture residual sums
    select s.band_key, sum(g.gs * g.gs) as ss
      from (select band_key, match_id, sum(pl) as sp, count(*) as k from s group by 1,2) g0
      join agg a on a.band_key = g0.band_key
      join lateral (select (g0.sp - g0.k * a.mu) as gs) g on true
      join s on s.band_key = g0.band_key and s.match_id = g0.match_id
     group by s.band_key
  ),
  clus2 as (  -- de-duplicate the join above back to one row per band
    select band_key, max(ss) as ss from (
      select g0.band_key, sum((g0.sp - g0.k * a.mu) * (g0.sp - g0.k * a.mu)) over (partition by g0.band_key) as ss
        from (select band_key, match_id, sum(pl) as sp, count(*) as k from s group by 1,2) g0
        join agg a on a.band_key = g0.band_key
    ) t group by band_key
  ),
  top as (
    select band_key, max(sp) as best_fixture_units
      from (select band_key, match_id, sum(pl) as sp from s group by 1,2) q
     group by band_key
  ),
  final as (
    select a.*,
           case when a.fixtures > 1 and c.ss > 0
                then sqrt((a.fixtures::numeric / (a.fixtures - 1)) * c.ss / (a.n::numeric * a.n))
           end as se,
           t.best_fixture_units
      from agg a
      left join clus2 c using (band_key)
      left join top   t using (band_key)
  )
  insert into public.band_calibration (
    as_of_date, window_days, band_key, band_label, edge_min, edge_max, odds_min, odds_max,
    backed, n, fixtures, wins, strike, avg_odds, avg_edge, yield, units,
    yield_se, yield_z, avg_no_vig_clv, clv_n, top_fixture_share, status, note)
  select
    v_as_of, p_window_days, band_key, band_label, edge_min, edge_max, odds_min, odds_max,
    backed, n, fixtures, wins,
    round(wins::numeric / nullif(n,0), 4),
    round(avg_odds, 3), round(avg_edge, 5),
    round(mu, 5), round(units, 3),
    round(se, 5),
    case when se > 0 then round(mu / se, 3) end,
    round(avg_clv, 5), clv_n,
    case when abs(units) > 0.5 then round(best_fixture_units / units, 3) end,
    case
      when fixtures < 30                                then 'insufficient'
      when mu < 0 and se > 0 and mu / se <= -1.0        then 'failing'
      when mu < 0                                       then 'watch'
      when abs(units) > 0.5
       and best_fixture_units / units > 0.50            then 'concentrated'
      else                                                   'healthy'
    end,
    case
      when fixtures < 30 then
        fixtures || ' fixtures — too few to read. Not evidence of anything either way.'
      when mu < 0 and se > 0 and mu / se <= -1.0 then
        'Yield ' || round(100*mu,2) || '% over ' || fixtures || ' fixtures, clustered z '
        || round(mu/se,2) || '. This band is losing money with the sample to say so.'
      when mu < 0 then
        'Yield ' || round(100*mu,2) || '% over ' || fixtures || ' fixtures — negative but '
        || 'inside noise. Watch, do not move.'
      when abs(units) > 0.5 and best_fixture_units / units > 0.50 then
        round(100 * best_fixture_units / units, 0) || '% of this band''s net units come from '
        || 'ONE fixture. The headline is a single result, not a trend.'
      else
        'Yield ' || round(100*mu,2) || '% over ' || fixtures || ' fixtures, clustered z '
        || coalesce(round(mu/se,2)::text, 'n/a') || '.'
    end
  from final;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

comment on function public.refresh_band_calibration(int, date) is
  'Writes one dated health snapshot per published band. ALERT ONLY — nothing reads the '
  'output to change behaviour. Run daily or weekly; idempotent per (as_of_date, window_days).';

revoke all on function public.refresh_band_calibration(int, date) from anon, authenticated;

commit;
