-- ---------------------------------------------------------------------------
-- 110 — the band window opens at the EPOCH, not at midnight.
--
-- THE BUG. `p_tracked_from` was typed `date`, defaulting to '2026-08-06'. The
-- join compares `v.detected_at >= p_tracked_from`, so Postgres widened the date
-- to midnight and the band window opened SIXTEEN HOURS before the tracked
-- record does. lib/epoch.js is explicit about why that instant is 16:00Z:
--
--   "THE INSTANT IS DELIBERATELY AFTER BOTH MERGES — engine 15:44 UTC,
--    frontend deploy READY 15:46 UTC — so no signal written by the old code
--    can fall inside the new record on a rounding argument."
--
-- The conviction ladder unified on 6 Aug: PRIME went from requiring only the
-- odds+edge box to requiring that AND a MaxEdgeScore of 65+. Signals chosen by
-- the old rule are a record for a method nobody is running.
--
-- WHAT IT COST. 31 pre-epoch signals worth -18.15u sat inside the Longshots
-- band, including MARKET_CONSENSUS rows from an architecture switched off in
-- the 5 Aug audit. Measured immediately before this migration:
--
--                        settled      net
--   performance_band        356    +16.29u   <- published
--   the same window at the epoch
--                           325    +34.44u
--
-- PRIME and EDGE contain zero pre-epoch signals and do not move. Longshots
-- does, and it moves in the FLATTERING direction — which is exactly why this
-- is its own migration with its own note rather than a quiet correction. The
-- published figure was understating the band by about 18 units.
--
-- The frontend already scoped every signal query to PERFORMANCE_EPOCH, so
-- /performance showed the band table and its own concentration panel
-- disagreeing on Longshots by that margin, on one screen. See eve-frontend#142
-- and eve-engine#109.
--
-- WHY DROP AND RECREATE. The parameter TYPE changes (date -> timestamptz), and
-- `create or replace function` cannot alter a signature. Everything else is
-- reproduced verbatim from pg_get_functiondef: SECURITY DEFINER, the pinned
-- search_path, and the grants migration 107 established — public EXECUTE stays
-- revoked, service_role keeps it.
--
-- `tracked_from` on performance_band remains a `date` column, so the stored
-- value is still 2026-08-06 and the site's "since 06 August" label is
-- unchanged. The cast is pinned to UTC rather than left to the session's
-- TimeZone, so a runner in a positive offset cannot record 2026-08-07.
-- ---------------------------------------------------------------------------

drop function if exists public.refresh_performance_by_band(date);

create or replace function public.refresh_performance_by_band(
  p_tracked_from timestamptz default '2026-08-06T16:00:00Z'
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
      -- MIRRORS lib/signalTier.js. `backed` means WE BROADCAST IT; `record_role`
      -- means whether it feeds the headline. EDGE is backed AND reference —
      -- that combination is the whole point of this migration.
      ('prime',      'PRIME',        1, true,  true,  'headline',  0.050, 0.070, 1.40, 3.00),
      ('edge',       'EDGE',         2, true,  true,  'reference', 0.070, 0.100, 1.40, 3.00),
      ('longshot',   'Longshots',    3, false, true,  'reference', 0.020, 1.000, 3.00, 1000.0),
      ('all_backed', 'PRIME + EDGE', 9, true,  false, 'internal',  0.050, 0.100, 1.40, 3.00)
  ),
  s as (
    select b.*, v.match_id, v.detected_odds, v.detected_edge, v.no_vig_clv, v.result,
           case when v.result = 'win' then v.detected_odds - 1 else -1 end as pl
      from bands b
      join public.value_signals v
        on v.detected_at >= p_tracked_from
       and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
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

-- Migration 107 revoked public EXECUTE on this function; a drop/recreate resets
-- grants to the default, so that revocation is re-applied here rather than
-- silently undone.
revoke all on function public.refresh_performance_by_band(timestamptz) from public;
revoke all on function public.refresh_performance_by_band(timestamptz) from anon, authenticated;
grant execute on function public.refresh_performance_by_band(timestamptz) to service_role;
