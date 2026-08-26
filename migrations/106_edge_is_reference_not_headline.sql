
-- 106 — EDGE comes OUT of the headline record and becomes a reference band.
--
-- Owner ruling, 26 Aug 2026. The published track record is PRIME only. EDGE is
-- still broadcast, still settled, still measured — it just does not feed the
-- number the site leads with.
--
-- `published` (RLS) and `record_role` (meaning) are now separate things:
--   record_role = 'headline'   the track record. PRIME alone.
--   record_role = 'reference'  measured and shown, never summed into the above.
--   record_role = 'internal'   published = false; diagnostics only.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE HONESTY PROBLEM THIS CREATES, AND THE ONE THING THAT FIXES IT.
--
-- We broadcast EDGE signals. If they are then absent from the published record,
-- the record covers only some of what we told people to bet — and "we count our
-- best band" is the single most damaging thing a tipster record can be accused
-- of, fairly or not.
--
-- What makes it defensible is DISCLOSURE AND EQUAL VISIBILITY, not the split
-- itself. So `headline_scope_note` is stored here rather than left to the
-- frontend to remember: any surface printing the headline yield MUST also print
-- this string. It is not decoration and it is not optional.
--
-- If EDGE ever stops being shown as prominently as PRIME, this split stops
-- being defensible and the right move is to fold EDGE back in — not to quietly
-- keep the flattering number.

begin;

alter table public.performance_band
  add column if not exists record_role text not null default 'reference';

alter table public.performance_band
  add column if not exists headline_scope_note text;

comment on column public.performance_band.record_role is
  'headline = the published track record (PRIME only). reference = measured and shown '
  'but never summed into the headline. internal = diagnostics, published = false. '
  'A reference band is still BROADCAST — see headline_scope_note.';

comment on column public.performance_band.headline_scope_note is
  'The disclosure any surface printing the headline yield must also print. Stored here '
  'rather than left to the frontend, because the split is only defensible if it is '
  'stated every time the number is.';

create or replace function public.refresh_performance_by_band(
  p_tracked_from date default date '2026-08-06'
)
returns int
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
    edge_min, edge_max, odds_min, odds_max, p_tracked_from,
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

comment on function public.refresh_performance_by_band(date) is
  'Refreshes the per-band record. PRIME is the headline; EDGE and Longshots are '
  'reference bands — measured and shown, never summed into the headline. A band '
  'publishes a yield only after clearing BOTH gates: 100 settled fixtures AND no more '
  'than half its net units from one fixture.';

revoke all on function public.refresh_performance_by_band(date) from anon, authenticated;

commit;
