-- ---------------------------------------------------------------------------
-- 119 — one selection, one bet: the record was counting the same bet up to
--       SEVEN times, once per re-detection at a new price.
--
-- THE REPORT. Two `Sabadell v Almeria · Draw · betfair_ex_uk` rows sat in the
-- PRIME table, 15:52 at 2.34 and 16:15 at 2.16, and BOTH settled LOST for
-- -1.00u each. One selection, one bet a follower could place, two units booked
-- against the record.
--
-- WHY IT HAPPENS AND WHY NOTHING CAUGHT IT. `value_signals_selection_price_
-- unique` includes `detected_odds`, so a re-detection at a different price is a
-- legitimately distinct ROW — that is deliberate and is not changed here, since
-- the price history of a signal is worth keeping. What was wrong is that the
-- RECORD read those rows as separate bets. `refresh_performance_by_band` joined
-- `value_signals` directly and `performance_signals` selected it row for row,
-- so every re-price was a fresh entry in the ledger and a fresh term in the
-- yield.
--
-- MEASURED BEFORE THIS MIGRATION, settled rows since the epoch:
--
--   band        rows   real selections   duplicated   worst   % of rows
--   prime         53                47            6      2x        11.3%
--   edge          87                62           17      4x        28.7%
--   longshot     325               190           76      7x        41.5%
--
-- WHAT IT DOES TO THE PUBLISHED FIGURES. This correction is CONSERVATIVE on
-- both backed bands — it removes yield rather than adding it, which is why it
-- is worth doing rather than worth arguing about:
--
--   band        bets            net        yield        win rate
--   prime       53 -> 47   +20.00 -> +16.67   37.74% -> 35.48%   60.4 -> 59.6
--   edge        87 -> 62    +5.01 ->  +1.11    5.75% ->  1.78%   44.8 -> 43.5
--   longshot   325 -> 190  +34.44 -> +22.68   10.60% -> 11.94%   29.2 -> 29.5
--
-- Longshots RISES because its duplicates were disproportionately losers. Two
-- thirds of EDGE's published yield was one bet counted twice.
--
-- THE RULE IS THE OWNER'S: the highest price, and the highest price only.
-- `distinct on (match_id, market, market_line, outcome)` ordered by
-- `detected_odds desc`, earliest detection breaking a tie.
--
-- AND THE ONE CAVEAT, STATED RATHER THAN BURIED. Of the 99 duplicated
-- selections the highest price was ALSO the first one we published on only 49;
-- on the other 50 the better price came later, so on those the record now
-- carries a price we published SECOND. The alternative rule — first detection,
-- which is the price a follower acting on the first alert actually got, and the
-- price CLV is measured from — was computed against the same rows and differs
-- by almost nothing:
--
--   band        highest price    first detection
--   prime             35.48%             35.43%
--   edge               1.78%              1.31%
--   longshot          11.94%             11.25%
--
-- Same bet count and same win rate on every band; only the yield moves, by at
-- most 0.69pp. Switching bases is changing `detected_odds desc` to `detected_at`
-- in the two places below, and nothing else.
--
-- THE DEDUPE IS PER SELECTION, NOT PER BAND, AND THAT IS LOAD-BEARING. A
-- re-detection at a different price carries a different edge, so it can land in
-- a DIFFERENT band: 14 of the 285 settled selections span two. Deduping inside
-- each band would leave those 14 bets counted once in PRIME and once in EDGE —
-- the same double-count this migration exists to remove, one level up. So the
-- selection is collapsed FIRST and the surviving row lands in whichever band
-- its own (odds, edge) puts it.
--
-- Both views are recreated with the same rule so the TABLE and the HEADLINE
-- cannot disagree — a frontend-only dedupe would have fixed the list under a
-- yield still computed from every row, which is the shape this project keeps
-- paying for. `security_invoker` is preserved exactly as found: false on the
-- settled view (the public record, deliberately definer) and true on pending
-- (RLS untouched, so the paywall still applies).
-- ---------------------------------------------------------------------------


-- ── the epoch, stated once ─────────────────────────────────────────────────
-- The dedupe has to happen inside the SAME window the record uses, or the two
-- disagree on the 4 selections that straddle it: a global dedupe can pick a
-- PRE-epoch row as the survivor, the frontend's `detected_at >= epoch` filter
-- then drops it, and that selection vanishes from the table while the band
-- table still counts its post-epoch row. So the instant is part of the
-- distinct-on key below.
--
-- It was already written twice — lib/epoch.js and this function's default —
-- and migration 110 is the record of what a third, subtly different copy costs
-- (a `date` cast opened the window 16 hours early). So it becomes a function
-- both sides read rather than a literal pasted once more. `performance_band.
-- tracked_from` is NOT usable for this: it is a `date`, which is exactly the
-- 16-hour bug 110 removed.
create or replace function public.performance_epoch()
  returns timestamptz language sql immutable parallel safe
  as $fn$ select '2026-08-06T16:00:00Z'::timestamptz $fn$;

grant execute on function public.performance_epoch() to anon, authenticated, service_role;

-- ── the settled record, deduped ────────────────────────────────────────────
create or replace view public.performance_signals
with (security_invoker = false) as
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
    from (
      select distinct on (v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
                          v.detected_at >= public.performance_epoch()) v.*
        from value_signals v
       where coalesce(v.result, 'pending') <> 'pending'
       order by v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
                (v.detected_at >= public.performance_epoch()),
                v.detected_odds desc, v.detected_at
    ) vs
    join matches m on m.id = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id;

-- ── the open book, same rule ───────────────────────────────────────────────
create or replace view public.performance_signals_pending
with (security_invoker = true) as
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
    from (
      select distinct on (v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
                          v.detected_at >= public.performance_epoch()) v.*
        from value_signals v
       where coalesce(v.result, 'pending') = 'pending'
       order by v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
                (v.detected_at >= public.performance_epoch()),
                v.detected_odds desc, v.detected_at
    ) vs
    join matches m on m.id = vs.match_id
    left join teams ht on ht.id = m.home_team_id
    left join teams at on at.id = m.away_team_id
    left join leagues l on l.id = m.league_id;

-- ── the band record, deduped at the same key ──────────────────────────────
drop function if exists public.refresh_performance_by_band(date);

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
      -- MIRRORS lib/signalTier.js. `backed` means WE BROADCAST IT; `record_role`
      -- means whether it feeds the headline. EDGE is backed AND reference —
      -- that combination is the whole point of this migration.
      ('prime',      'PRIME',        1, true,  true,  'headline',  0.050, 0.070, 1.40, 3.00),
      ('edge',       'EDGE',         2, true,  true,  'reference', 0.070, 0.100, 1.40, 3.00),
      ('longshot',   'Longshots',    3, false, true,  'reference', 0.020, 1.000, 3.00, 1000.0),
      ('all_backed', 'PRIME + EDGE', 9, true,  false, 'internal',  0.050, 0.100, 1.40, 3.00)
  ),
  -- ONE SELECTION, ONE BET (migration 119). The same selection is re-detected
  -- whenever its price moves, and every one of those rows used to join here as
  -- a separate bet: 41.5% of the Longshots rows were repeats, one selection
  -- seven times over. Collapse to the highest price BEFORE the band join, so a
  -- re-price that lands in a different band cannot smuggle the same bet into
  -- two records.
  picked as (
    select distinct on (v.match_id, v.market, coalesce(v.market_line, -1), v.outcome) v.*
      from public.value_signals v
     where v.detected_at >= p_tracked_from
     order by v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
              v.detected_odds desc, v.detected_at
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

-- Migration 107 revoked public EXECUTE on this function; a drop/recreate resets
-- grants to the default, so that revocation is re-applied here rather than
-- silently undone.
revoke all on function public.refresh_performance_by_band(timestamptz) from public;
revoke all on function public.refresh_performance_by_band(timestamptz) from anon, authenticated;
grant execute on function public.refresh_performance_by_band(timestamptz) to service_role;

-- ── recompute, then PROVE it before the transaction commits ────────────────
-- The runner wraps a migration in one transaction, so a raise below aborts the
-- whole file: the assertions ARE the rehearsal and nothing lands if they fail.
select public.refresh_performance_by_band();

do $$
declare
  v_rows_prime int; v_sel_prime int; v_band_prime int;
  v_view_rows int;  v_view_sel int;
  v_pend_rows int;  v_pend_sel int;
begin
  -- 1. The settled view holds exactly one row per selection.
  select count(*) into v_view_rows from public.performance_signals;
  select count(*) into v_view_sel from (
    select 1 from public.performance_signals
     group by fixture, market, coalesce(market_line, -1), outcome) q;
  if v_view_rows <> v_view_sel then
    raise exception 'performance_signals still holds % rows for % selections',
      v_view_rows, v_view_sel;
  end if;

  -- 2. So does the open book.
  select count(*) into v_pend_rows from public.performance_signals_pending;
  select count(*) into v_pend_sel from (
    select 1 from public.performance_signals_pending
     group by fixture, market, coalesce(market_line, -1), outcome) q;
  if v_pend_rows <> v_pend_sel then
    raise exception 'performance_signals_pending still holds % rows for % selections',
      v_pend_rows, v_pend_sel;
  end if;

  -- 3. THE TABLE AND THE HEADLINE AGREE. This is the assertion that matters:
  --    a dedupe applied to one and not the other is the failure this migration
  --    is fixing, wearing a different hat.
  select count(*) into v_rows_prime
    from public.performance_signals
   where band = 'prime' and result in ('win','loss')
     and detected_at >= public.performance_epoch();
  select settled_signals into v_band_prime
    from public.performance_band where band_key = 'prime';
  if v_rows_prime <> v_band_prime then
    raise exception 'prime: ledger says % settled, band table says %',
      v_rows_prime, v_band_prime;
  end if;

  -- 4. And the correction actually moved: PRIME settled 53 before this.
  if v_band_prime >= 53 then
    raise exception 'prime settled_signals is % — the dedupe did not bite', v_band_prime;
  end if;

  raise notice 'OK — settled view % rows / % selections, prime settled % (was 53)',
    v_view_rows, v_view_sel, v_band_prime;
end $$;
