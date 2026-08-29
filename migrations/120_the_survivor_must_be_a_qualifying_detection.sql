-- ---------------------------------------------------------------------------
-- 120 — the survivor must be a detection we actually PUBLISHED as that band.
--
-- 119 kept the single highest price whatever its edge. But the price and the
-- edge travel together, so the highest-price row can carry an edge OUTSIDE
-- every published band — and then the whole selection left the record.
-- Measured immediately after 119: PRIME went 53 -> 33 settled, and those 20
-- were signals we HAD published as PRIME, dropped because a different
-- detection of the same bet happened to sit outside the box.
--
-- The rule the owner asked for is "the PRIME signal, recorded at the highest
-- price". So the survivor is chosen among the detections that QUALIFIED for a
-- published band, falling back to an unqualified row only when the selection
-- never qualified at all — those are the sub-threshold rows, which the record
-- does not track and which the ledger still lists under its own tab.
--
--   band        119 (highest, full stop)   120 (highest QUALIFYING)
--   prime       33 bets  63.6%  +41.74%    38 bets  65.8%  +48.27%  z 2.68
--   edge        35 bets  40.0%   -2.34%    57 bets  42.1%   -1.66%
--   longshot   190 bets  29.5%  +11.94%   190 bets  29.5%  +11.94%
--
-- Longshots does not move: nothing there had a qualifying/unqualifying split.
-- One selection is still ONE bet and the 14 selections that span two bands are
-- still collapsed to one — that is 119's correction and it stands.
--
-- THE OWNER CHOSE THIS WITH ALL THREE OPTIONS MEASURED IN FRONT OF THEM, the
-- third being first-detection (the price a follower acting on the first alert
-- actually got, and the price CLV is measured from). It costs at most 0.69pp of
-- yield against highest-price, same bet count and same win rate; switching is
-- `detected_odds desc` -> `detected_at` in the three places below.
--
-- `qualified` is derived from the SAME band boxes the join uses, so the keep
-- rule and the band assignment cannot drift apart.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_performance_by_band(
  p_tracked_from timestamptz default public.performance_epoch()
)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_catalog'
as $function$
declare v_rows int;
begin
  with bands(band_key, band_label, sort_order, backed, published, record_role,
             edge_min, edge_max, odds_min, odds_max) as (
    values
      ('prime',      'PRIME',        1, true,  true,  'headline',  0.050, 0.070, 1.40, 3.00),
      ('edge',       'EDGE',         2, true,  true,  'reference', 0.070, 0.100, 1.40, 3.00),
      ('longshot',   'Longshots',    3, false, true,  'reference', 0.020, 1.000, 3.00, 1000.0),
      ('all_backed', 'PRIME + EDGE', 9, true,  false, 'internal',  0.050, 0.100, 1.40, 3.00)
  ),
  -- ONE SELECTION, ONE BET (119), AT THE HIGHEST QUALIFYING PRICE (120).
  -- `qualified` is "this detection sits inside a PUBLISHED band" — the same
  -- three boxes below, so the two cannot drift. Ordering by it first keeps a
  -- PRIME signal in PRIME rather than evicting it because some other detection
  -- of the same bet carried an out-of-box edge.
  scored as (
    select v.*,
           exists (select 1 from bands b
                    where b.published
                      and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
                      and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max)
             as qualified
      from public.value_signals v
     where v.detected_at >= p_tracked_from
  ),
  picked as (
    select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
      from scored
     order by match_id, market, coalesce(market_line, -1), outcome,
              qualified desc, detected_odds desc, detected_at
  ),
  s as (
    select b.*, v.match_id, v.detected_odds, v.detected_edge, v.no_vig_clv, v.result,
           case when v.result = 'win' then v.detected_odds - 1 else -1 end as pl
      from bands b
      join picked v
        on v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
       and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max
  ),
  settled as (select * from s where result in ('win','loss')),
  agg as (
    select b.band_key, b.band_label, b.sort_order, b.backed, b.published, b.record_role,
           b.edge_min, b.edge_max, b.odds_min, b.odds_max,
           (select count(*) from s where s.band_key = b.band_key)::int as total_signals,
           (select count(*) from settled where settled.band_key = b.band_key)::int as settled_signals,
           (select count(distinct match_id) from settled where settled.band_key = b.band_key)::int as settled_fixtures,
           (select count(*) from settled where settled.band_key = b.band_key and result='win')::int as wins,
           (select count(*) from settled where settled.band_key = b.band_key and result='loss')::int as losses,
           (select avg(pl) from settled where settled.band_key = b.band_key) as mu,
           (select sum(pl) from settled where settled.band_key = b.band_key) as units,
           (select avg(detected_odds) from settled where settled.band_key = b.band_key) as avg_odds,
           (select avg(detected_edge) from settled where settled.band_key = b.band_key) as avg_edge,
           (select avg(no_vig_clv) from settled where settled.band_key = b.band_key) as avg_clv,
           (select count(no_vig_clv) from settled where settled.band_key = b.band_key)::int as clv_n
      from bands b
  ),
  fixture as (select band_key, match_id, sum(pl) sp, count(*) k from settled group by 1,2),
  clus as (
    select f.band_key,
           sum((f.sp - f.k * a.mu) * (f.sp - f.k * a.mu)) ss,
           max(f.sp) best
      from fixture f join agg a using (band_key) group by f.band_key
  ),
  final as (
    select a.*, 
           case when a.settled_fixtures > 1 and c.ss > 0
                then sqrt((a.settled_fixtures::numeric / (a.settled_fixtures - 1))
                          * c.ss / (a.settled_signals::numeric * a.settled_signals))
           end as se,
           case when a.units >= 1.0 and c.best > 0 then least(c.best / a.units, 1.0) end as share
      from agg a left join clus c using (band_key)
  ),
  gated as (
    select f.*,
           (f.settled_fixtures < 100) as thin,
           (f.share is not null and f.share > 0.50) as concentrated
      from final f
  )
  insert into public.performance_band (
    band_key, band_label, sort_order, backed, published, record_role,
    edge_min, edge_max, odds_min, odds_max, tracked_from,
    total_signals, settled_signals, settled_fixtures, wins, losses,
    win_rate, breakeven_strike, avg_odds, avg_edge, yield, units,
    yield_se, yield_z, avg_no_vig_clv, clv_n, top_fixture_share,
    insufficient, insufficient_reason, headline_scope_note, calculated_at)
  select
    band_key, band_label, sort_order, backed, published, record_role,
    edge_min, edge_max, odds_min, odds_max,
    (p_tracked_from at time zone 'UTC')::date,
    total_signals, settled_signals, settled_fixtures, wins, losses,
    round(wins::numeric / nullif(settled_signals, 0), 4),
    round(1.0 / nullif(avg_odds, 0), 4),
    round(avg_odds, 3), round(avg_edge, 5),
    round(mu, 5), round(units, 3), round(se, 5),
    case when se > 0 then round(mu / se, 3) end,
    round(avg_clv, 5), clv_n, round(share, 3),
    (thin or concentrated),
    case
      when thin and concentrated then
        settled_fixtures || ' settled fixtures, below the 100 required — and '
        || round(100 * share, 0) || '% of the net comes from one fixture.'
      when thin then
        settled_fixtures || ' settled fixtures — below the 100 this platform requires '
        'before a yield is a result.'
      when concentrated then
        'Gate cleared on sample (' || settled_fixtures || ' fixtures), but '
        || round(100 * share, 0) || '% of the net comes from a SINGLE fixture. A yield '
        'carried by one match is not a record, so it stays withheld.'
      else
        'Gate cleared: ' || settled_fixtures || ' settled fixtures, best fixture '
        || coalesce(round(100 * share, 0)::text, '0') || '% of net.'
    end,
    case
      when record_role = 'headline' then
        'Our published record covers PRIME signals only. We also publish EDGE signals, '
        'which are settled and reported separately on the EDGE tab and are not included '
        'in this figure.'
      when band_key = 'edge' then
        'EDGE signals are published like PRIME ones and settled the same way, but they '
        'are reported here rather than in the headline record.'
      else null
    end,
    now()
  from gated
  on conflict (band_key) do update set
    band_label = excluded.band_label, sort_order = excluded.sort_order,
    backed = excluded.backed, published = excluded.published,
    record_role = excluded.record_role,
    edge_min = excluded.edge_min, edge_max = excluded.edge_max,
    odds_min = excluded.odds_min, odds_max = excluded.odds_max,
    tracked_from = excluded.tracked_from,
    total_signals = excluded.total_signals, settled_signals = excluded.settled_signals,
    settled_fixtures = excluded.settled_fixtures, wins = excluded.wins, losses = excluded.losses,
    win_rate = excluded.win_rate, breakeven_strike = excluded.breakeven_strike,
    avg_odds = excluded.avg_odds, avg_edge = excluded.avg_edge,
    yield = excluded.yield, units = excluded.units,
    yield_se = excluded.yield_se, yield_z = excluded.yield_z,
    avg_no_vig_clv = excluded.avg_no_vig_clv, clv_n = excluded.clv_n,
    top_fixture_share = excluded.top_fixture_share,
    insufficient = excluded.insufficient, insufficient_reason = excluded.insufficient_reason,
    headline_scope_note = excluded.headline_scope_note,
    calculated_at = excluded.calculated_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

revoke all on function public.refresh_performance_by_band(timestamptz) from public;
revoke all on function public.refresh_performance_by_band(timestamptz) from anon, authenticated;
grant execute on function public.refresh_performance_by_band(timestamptz) to service_role;

-- The LEDGER must pick the same survivor as the RECORD, or the table and the
-- headline disagree — which is the whole reason 119 changed both together.
create or replace view public.performance_signals
with (security_invoker = false) as
  with scored as (
    select v.*,
           exists (select 1 from performance_band b
                    where b.published
                      and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
                      and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max)
             as qualified
      from value_signals v
     where coalesce(v.result, 'pending') <> 'pending'
  ),
  picked as (
    select distinct on (match_id, market, coalesce(market_line, -1), outcome,
                        detected_at >= public.performance_epoch()) *
      from scored
     order by match_id, market, coalesce(market_line, -1), outcome,
              (detected_at >= public.performance_epoch()),
              qualified desc, detected_odds desc, detected_at
  )
  select vs.id, vs.detected_at, vs.kickoff_at,
         ((ht.name || ' v '::text) || at.name) as fixture,
         ht.name as home_team, at.name as away_team,
         coalesce(l.name, vs.league_tag) as league,
         vs.market, vs.market_line, vs.outcome,
         vs.detected_odds as advised_odds, vs.closing_odds,
         round((vs.detected_edge * 100::numeric), 2) as edge_pct,
         round((vs.no_vig_clv * 100::numeric), 2) as no_vig_clv_pct,
         vs.result, vs.bookmaker,
         round((vs.model_prob * 100::numeric), 1) as model_prob_pct,
         round((vs.market_prob * 100::numeric), 1) as market_prob_pct,
         vs.mxs, vs.mxs_band, vs.score_withheld_reason, vs.model_architecture,
         (select p.band_key from performance_band p
           where p.published = true
             and vs.detected_edge >= p.edge_min and vs.detected_edge < p.edge_max
             and vs.detected_odds >= p.odds_min and vs.detected_odds < p.odds_max
           order by case p.band_key when 'prime' then 1 when 'edge' then 2 else 3 end
           limit 1) as band
    from picked vs
    join matches m on m.id = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id;

create or replace view public.performance_signals_pending
with (security_invoker = true) as
  with scored as (
    select v.*,
           exists (select 1 from performance_band b
                    where b.published
                      and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
                      and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max)
             as qualified
      from value_signals v
     where coalesce(v.result, 'pending') = 'pending'
  ),
  picked as (
    select distinct on (match_id, market, coalesce(market_line, -1), outcome,
                        detected_at >= public.performance_epoch()) *
      from scored
     order by match_id, market, coalesce(market_line, -1), outcome,
              (detected_at >= public.performance_epoch()),
              qualified desc, detected_odds desc, detected_at
  )
  select vs.id, vs.detected_at, vs.kickoff_at,
         ((ht.name || ' v '::text) || at.name) as fixture,
         ht.name as home_team, at.name as away_team,
         coalesce(l.name, vs.league_tag) as league,
         vs.market, vs.market_line, vs.outcome,
         vs.detected_odds as advised_odds, vs.closing_odds,
         round((vs.detected_edge * 100::numeric), 2) as edge_pct,
         round((vs.no_vig_clv * 100::numeric), 2) as no_vig_clv_pct,
         vs.result, vs.bookmaker,
         round((vs.model_prob * 100::numeric), 1) as model_prob_pct,
         round((vs.market_prob * 100::numeric), 1) as market_prob_pct,
         vs.mxs, vs.mxs_band, vs.score_withheld_reason, vs.model_architecture,
         (select p.band_key from performance_band p
           where p.published = true
             and vs.detected_edge >= p.edge_min and vs.detected_edge < p.edge_max
             and vs.detected_odds >= p.odds_min and vs.detected_odds < p.odds_max
           order by case p.band_key when 'prime' then 1 when 'edge' then 2 else 3 end
           limit 1) as band
    from picked vs
    join matches m on m.id = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id;

select public.refresh_performance_by_band();

do $$
declare v_rows int; v_sel int; v_ledger int; v_band int;
begin
  select count(*) into v_rows from public.performance_signals;
  select count(*) into v_sel from (
    select 1 from public.performance_signals
     group by fixture, market, coalesce(market_line,-1), outcome,
              (detected_at >= public.performance_epoch())) q;
  if v_rows <> v_sel then
    raise exception 'ledger holds % rows for % selections', v_rows, v_sel;
  end if;

  select count(*) into v_ledger from public.performance_signals
   where band = 'prime' and result in ('win','loss')
     and detected_at >= public.performance_epoch();
  select settled_signals into v_band from public.performance_band where band_key='prime';
  if v_ledger <> v_band then
    raise exception 'prime: ledger % vs band table %', v_ledger, v_band;
  end if;
  if v_band <> 38 then
    raise exception 'prime settled is %, expected the measured 38', v_band;
  end if;
  raise notice 'OK — one row per selection, prime settled % and ledger agrees', v_band;
end $$;
