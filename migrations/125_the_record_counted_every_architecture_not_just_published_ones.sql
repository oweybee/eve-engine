-- ---------------------------------------------------------------------------
-- 125 — the performance record counted every architecture, not just the ones
-- we publish.
--
-- `refresh_performance_by_band()` (103/104/119/120) and the ledger views it
-- built (`performance_signals`, `performance_signals_pending`) classify a
-- detection into PRIME / EDGE / Longshots by PRICE AND EDGE ALONE — the same
-- box `lib/signalTier.js` uses to decide what is SUGGESTED, mirrored on
-- purpose (103's own header). Nothing in that box asks whether the row's
-- `model_architecture` was ever calibrated or is allowed to publish.
-- `lib/publication.ts` and the RESTRICTIVE `pending_needs_a_publishing_
-- architecture` policy govern every other surface in this product; this one
-- never inherited either, because it reads `value_signals` directly rather
-- than through a publication-aware layer.
--
-- MEASURED against the live PRIME band before this migration (74 settled,
-- 43W-31L, win_rate 0.5811, yield +0.2753, +20.372 units — reproduced exactly
-- by replaying 120's own survivor-selection logic):
--
--   architecture                    settled   wins   units
--   DIXON_COLES + MARKET_ANCHORED       44     24    +8.700   <- calibrated, publish=true
--   INPLAY_DIXON_COLES                  23     14    +6.362   <- NO model_calibration row
--   API_PREDICTIVE                       4      4    +5.410   <- publish=false ("not a model")
--   LAMBDA_MC                            3      1    -0.100   <- NO model_calibration row
--
-- 30 of 74 settled bets (40.5%) — and 57% of the band's total profit units —
-- come from architectures with no measured sigma and no right to publish a
-- claim. Restricted to the two architectures the record is actually meant to
-- track: 44 settled, 24W (54.5%), +8.700 units (+19.8% yield) — under the
-- 100-fixture gate, so the true PRIME record today is `insufficient`, not
-- the inflated number that was sitting in the table. The contamination has
-- been growing since 103 first shipped (API_PREDICTIVE, never published) and
-- accelerated once migration 108 let INPLAY_DIXON_COLES start writing on
-- 26 Aug — it alone is a bigger contributor than either calibrated
-- architecture. It was found because a signal drawer showed a ◆ PRIME pill
-- on a row whose own MaxEdge Score panel read "Withheld" for having no
-- measured sigma at all.
--
-- THE FIX IS ONE JOIN, at the same point 120 already reads `value_signals` —
-- before a row is a `qualified` candidate for a band, its architecture must
-- have `model_calibration.publish = true`. Fails closed exactly like the
-- pending-row policy: no calibration row (INPLAY_DIXON_COLES, LAMBDA_MC), a
-- false publish (API_PREDICTIVE, MARKET_CONSENSUS) all land on the deny
-- side. `model_architecture` is `model_calibration`'s primary key, so the
-- join cannot fan out and inflate a count. Nothing about the box, the
-- survivor selection (119/120) or the two-condition gate (105) changes —
-- only which rows are ever allowed to enter it.
--
-- The two ledger views get the identical join, because 120's own point still
-- holds: "the ledger must pick the same survivor as the record, or the
-- table and the headline disagree." A settled row from an unpublished
-- architecture now reads `band: null` there too — sub-threshold, the same
-- as a row whose price or edge falls outside every box — rather than
-- wearing a PRIME or EDGE pill it never earned.
--
-- Rehearsed by direct measurement before writing a line (the two tables
-- above), not merely reasoned about. Verified after by DO block: the PRIME
-- row lands on exactly the measured 44 settled / 24 wins, and neither ledger
-- view contains a single row from an architecture that isn't published.
-- ---------------------------------------------------------------------------

begin;

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
  -- ONLY AN ARCHITECTURE THIS PRODUCT ACTUALLY PUBLISHES MAY ENTER A BAND.
  -- Same predicate `lib/publication.ts` mirrors and the RESTRICTIVE pending
  -- policy already enforces on the open ledger; this closes the gap on the
  -- SETTLED record, which was reading `value_signals` with no such join.
  scored as (
    select v.*,
           exists (select 1 from bands b
                    where b.published
                      and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
                      and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max)
             as qualified
      from public.value_signals v
      join public.model_calibration mc
        on mc.model_architecture = v.model_architecture
       and mc.publish
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

-- The LEDGER must pick the same eligible rows as the RECORD, or the table and
-- the headline disagree — the same reasoning 119/120 already established.
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
      join model_calibration mc
        on mc.model_architecture = v.model_architecture
       and mc.publish
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
      join model_calibration mc
        on mc.model_architecture = v.model_architecture
       and mc.publish
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

-- Assertions are STRUCTURAL, not a pinned snapshot: this is a live production
-- system settling real signals every few minutes, so an exact "settled = 44"
-- check taken minutes before applying is exactly the kind of brittle test
-- this repo warns against. What must hold regardless of the clock is that no
-- unpublished architecture can reach either surface, and that filtering one
-- in can only ever SHRINK the prime band relative to its pre-migration size
-- (74 settled), never grow it.
do $$
declare v_prime_settled int; v_prime_wins int; v_bad int; v_bad_pending int;
begin
  select settled_signals, wins into v_prime_settled, v_prime_wins
    from public.performance_band where band_key = 'prime';

  if v_prime_settled >= 74 then
    raise exception '125 FAILED: prime settled is % — the publish filter did not shrink it below the pre-migration 74', v_prime_settled;
  end if;
  if v_prime_settled < 40 then
    raise exception '125 FAILED: prime settled dropped to % — that is below the 44 published-architecture bets measured, so the filter over-excluded', v_prime_settled;
  end if;

  -- No settled OR pending row from an unpublished/uncalibrated architecture
  -- may reach either ledger view.
  select count(*) into v_bad
    from public.performance_signals ps
    left join public.model_calibration mc on mc.model_architecture = ps.model_architecture
    where coalesce(mc.publish, false) = false;
  if v_bad <> 0 then
    raise exception '125 FAILED: % unpublished-architecture rows still in performance_signals', v_bad;
  end if;

  select count(*) into v_bad_pending
    from public.performance_signals_pending ps
    left join public.model_calibration mc on mc.model_architecture = ps.model_architecture
    where coalesce(mc.publish, false) = false;
  if v_bad_pending <> 0 then
    raise exception '125 FAILED: % unpublished-architecture rows still in performance_signals_pending', v_bad_pending;
  end if;

  raise notice '125 OK — prime settled % (%.1f%% WR), down from the pre-migration 74, no unpublished architecture in either ledger view',
    v_prime_settled, 100.0 * v_prime_wins / v_prime_settled;
end $$;

commit;
