-- ---------------------------------------------------------------------------
-- 127 — closing-line value is measured at the price a follower was ALERTED at,
--       not at the highest price the same bet was later re-detected at.
--
-- THE FINDING. `no_vig_clv = ln(detected_odds / closing no_vig_odds)` per row
-- (062, 087). 119 collapsed re-detections of one selection to ONE bet and 120
-- kept the highest-priced QUALIFYING detection as the survivor — the owner's
-- rule for the YIELD, and 120's own header measures the cost of that choice on
-- yield at no more than 0.69pp. CLV is a different quantity: it is a function
-- of the detected price DIRECTLY, so choosing the maximum `detected_odds`
-- among duplicates maximises ln(detected / close) by construction. On the
-- Sabadell v Almeria example in 119's header (2.34 against 2.16) that is about
-- 8 percentage points of CLV on one bet, from the choice of row alone.
--
-- 119's header already says which price a follower actually got: "the first
-- detection ... is the price a follower acting on the first alert actually
-- got, and the price CLV is measured from". So the yield keeps 120's survivor
-- and the CLV moves to the FIRST detection that qualified for the band.
--
-- WHY IT MATTERS NOW. Together with 125 removing unpublished architectures
-- from the record, this is the likeliest explanation for PRIME's no-vig CLV
-- moving from +0.86% (26 Aug) to +4.64% and EDGE's from -2.02% to +7.23%
-- (15 Sep). Neither figure may be quoted anywhere public until the basis is
-- stated beside it, which is what `clv_basis` is for.
--
-- WHAT THIS DOES.
--   1. `performance_band` gains `clv_basis` (NOT NULL, default
--      'first_detection', CHECK-bounded), `avg_no_vig_clv_highest_price` and
--      `clv_n_highest_price` — the RETIRED basis kept beside the published
--      one, so /performance can DERIVE whether the two bases disagree by more
--      than a point and print a dated note only when they do, rather than
--      typing a sentence that goes stale. And `clv_basis_since`, the date the
--      basis changed, so the note's date is read and not remembered.
--   2. `refresh_performance_by_band()` computes `avg_no_vig_clv` / `clv_n`
--      from the first qualifying detection per selection PER BAND, and the
--      old survivor's mean into the `_highest_price` columns. Yield, win
--      rate, units, the gate and the two ledger views are UNTOUCHED — 119
--      and 120 stand for everything except which row's CLV is averaged.
--
-- THE SET IS "BAND FIRST, THEN EARLIEST", which is the brief's own 4a
-- measurement and NOT 120's shape with `detected_at` swapped in. 120 picks
-- one survivor per selection and then bands it; doing that for CLV would file
-- a selection whose earliest qualifying detection was EDGE and whose later one
-- was PRIME under EDGE's CLV while its yield sits in PRIME, and the band's
-- `clv_n` would stop being a subset of its own `settled_signals`. Banding
-- first means a selection that qualified in two bands contributes its first
-- price IN EACH — 14 of 285 settled selections at 119's count — which is a
-- mean over "the first price we published as PRIME", stated as such, and not
-- a double-counted unit of profit.
--
-- THE OPERATORS ARE 120's, NOT THE BRIEF'S SQL. The brief's measurement wrote
-- `detected_odds between 1.40 and 3.00` (inclusive at 3.00) and
-- `result is not null` (which admits 'void'); the record uses `< odds_max`
-- and `result in ('win','loss')`, and the brief itself says to check the box
-- operators against 120 before trusting the numbers. The comparison printed
-- below uses the record's operators so it matches the table it is checking.
--
-- THE MEASUREMENT RUNS AT APPLY TIME, printed as NOTICEs: both bases per
-- band, their gap, and both counts. It could not be run from the environment
-- this was written in (no database credential of any kind, and no SQL runner
-- in either repo), so the numbers land in the SQL editor's output when this
-- is applied rather than in this header. Read them there and carry them into
-- CLAUDE.md; a number typed here in advance would be a guess wearing a
-- measurement's clothes.
--
-- ACCEPTANCE, asserted rather than eyeballed: after the refresh,
-- `performance_band.avg_no_vig_clv` for PRIME and EDGE equals an INDEPENDENT
-- first-detection mean (the brief's 4a query in 120's operators, written out
-- separately below rather than by calling the function's own CTE) to 5 dp,
-- and the `_highest_price` column equals the old basis the same way. Every
-- row carries `clv_basis = 'first_detection'`.
--
-- SAFE TO APPLY TWICE: the columns are `add column if not exists`, the
-- function is `create or replace`, and the refresh is idempotent.
-- ---------------------------------------------------------------------------

begin;

alter table public.performance_band
  add column if not exists clv_basis text not null default 'first_detection',
  add column if not exists avg_no_vig_clv_highest_price numeric,
  add column if not exists clv_n_highest_price integer,
  add column if not exists clv_basis_since date not null default date '2026-09-15';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.performance_band'::regclass
       and conname = 'performance_band_clv_basis_check'
  ) then
    alter table public.performance_band
      add constraint performance_band_clv_basis_check
      check (clv_basis in ('first_detection', 'highest_price'));
  end if;
end $$;

comment on column public.performance_band.clv_basis is
  'Which detection of a re-detected selection the no-vig CLV is averaged from. '
  'first_detection = the first price published as this band (the price a '
  'follower acting on the first alert got); highest_price = 119/120''s yield '
  'survivor, retired as a CLV basis by 127 because it maximises CLV by '
  'construction.';
comment on column public.performance_band.avg_no_vig_clv_highest_price is
  'The retired basis, kept beside the published one so the surface can state '
  'how far apart they sit rather than a reader having to trust a note.';

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
  -- THE CLOSING-LINE VALUE IS MEASURED AT THE FIRST PRICE WE PUBLISHED AS
  -- THIS BAND (127). `picked` keeps 119/120's survivor for the yield — the
  -- highest QUALIFYING price — and that is the one basis CLV must not share:
  -- no_vig_clv = ln(detected_odds / fair close), so choosing the maximum
  -- detected_odds among re-detections maximises the CLV by construction. A
  -- follower acting on the first alert got the first price, so that is the
  -- price the close is measured from. Band FIRST, then earliest per
  -- selection, so the set is "the first detection that qualified for THIS
  -- band" — the brief's own 4a measurement, restated with 120's operators.
  first_in_band as (
    select distinct on (b.band_key, v.match_id, v.market, coalesce(v.market_line, -1), v.outcome)
           b.band_key, v.no_vig_clv, v.result
      from bands b
      join scored v
        on v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
       and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max
     order by b.band_key, v.match_id, v.market, coalesce(v.market_line, -1), v.outcome,
              v.detected_at
  ),
  settled_first as (select * from first_in_band where result in ('win','loss')),
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
           -- the published basis: first qualifying detection
           (select avg(no_vig_clv) from settled_first where settled_first.band_key = b.band_key) as avg_clv,
           (select count(no_vig_clv) from settled_first where settled_first.band_key = b.band_key)::int as clv_n,
           -- the retired basis, kept so a reader can be told how far apart they sit
           (select avg(no_vig_clv) from settled where settled.band_key = b.band_key) as avg_clv_hp,
           (select count(no_vig_clv) from settled where settled.band_key = b.band_key)::int as clv_n_hp
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
    clv_basis, avg_no_vig_clv_highest_price, clv_n_highest_price,
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
    'first_detection', round(avg_clv_hp, 5), clv_n_hp,
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
    clv_basis = excluded.clv_basis,
    avg_no_vig_clv_highest_price = excluded.avg_no_vig_clv_highest_price,
    clv_n_highest_price = excluded.clv_n_highest_price,
    top_fixture_share = excluded.top_fixture_share,
    insufficient = excluded.insufficient, insufficient_reason = excluded.insufficient_reason,
    headline_scope_note = excluded.headline_scope_note,
    calculated_at = excluded.calculated_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end $function$;

-- Recompute every band on the new basis. Idempotent.
select public.refresh_performance_by_band();

-- ── ACCEPTANCE ──────────────────────────────────────────────────────────────
-- The brief's 4a measurement, written INDEPENDENTLY of the function's CTEs so
-- it checks the table rather than restating it, in the record's operators.
do $$
declare
  r record;
  v_first numeric; v_first_n int; v_hp numeric; v_hp_n int;
  v_row record;
begin
  for r in
    select band_key, edge_min, edge_max, odds_min, odds_max
      from public.performance_band
     where published
     order by sort_order
  loop
    with q as (
      select v.*
        from public.value_signals v
        join public.model_calibration mc
          on mc.model_architecture = v.model_architecture and mc.publish
       where v.detected_at >= public.performance_epoch()
         and v.result in ('win','loss')
         and v.detected_edge >= r.edge_min and v.detected_edge < r.edge_max
         and v.detected_odds >= r.odds_min and v.detected_odds < r.odds_max
    ),
    fi as (
      select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
        from q
       order by match_id, market, coalesce(market_line, -1), outcome, detected_at
    )
    select round(avg(no_vig_clv), 5), count(no_vig_clv)
      into v_first, v_first_n
      from fi;

    select avg_no_vig_clv, clv_n, avg_no_vig_clv_highest_price, clv_n_highest_price, clv_basis
      into v_row
      from public.performance_band where band_key = r.band_key;

    raise notice '[127] % — first_detection avg_no_vig_clv %  (n=%)   highest_price %  (n=%)   gap % pp',
      r.band_key, v_row.avg_no_vig_clv, v_row.clv_n,
      v_row.avg_no_vig_clv_highest_price, v_row.clv_n_highest_price,
      round(coalesce(v_row.avg_no_vig_clv, 0) * 100 - coalesce(v_row.avg_no_vig_clv_highest_price, 0) * 100, 2);

    if v_row.clv_basis <> 'first_detection' then
      raise exception '[127] % carries clv_basis %', r.band_key, v_row.clv_basis;
    end if;
    if v_row.clv_n <> v_first_n then
      raise exception '[127] % clv_n % but the independent first-detection count is %',
        r.band_key, v_row.clv_n, v_first_n;
    end if;
    if v_first_n > 0 and v_row.avg_no_vig_clv is distinct from v_first then
      raise exception '[127] % avg_no_vig_clv % but the independent first-detection mean is %',
        r.band_key, v_row.avg_no_vig_clv, v_first;
    end if;
  end loop;

  -- The retired basis must still reproduce 120's survivor mean, so the pair on
  -- the row is genuinely the two bases and not the same number twice.
  with bands as (
    select band_key, edge_min, edge_max, odds_min, odds_max
      from public.performance_band where published
  ),
  scored as (
    select v.*,
           exists (select 1 from bands b
                    where v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
                      and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max)
             as qualified
      from public.value_signals v
      join public.model_calibration mc
        on mc.model_architecture = v.model_architecture and mc.publish
     where v.detected_at >= public.performance_epoch()
  ),
  picked as (
    select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
      from scored
     order by match_id, market, coalesce(market_line, -1), outcome,
              qualified desc, detected_odds desc, detected_at
  )
  select round(avg(p.no_vig_clv), 5), count(p.no_vig_clv)
    into v_hp, v_hp_n
    from picked p
    join bands b
      on p.detected_odds >= b.odds_min and p.detected_odds < b.odds_max
     and p.detected_edge >= b.edge_min and p.detected_edge < b.edge_max
   where b.band_key = 'prime' and p.result in ('win','loss');

  select avg_no_vig_clv_highest_price, clv_n_highest_price into v_row
    from public.performance_band where band_key = 'prime';
  if v_row.clv_n_highest_price <> v_hp_n
     or (v_hp_n > 0 and v_row.avg_no_vig_clv_highest_price is distinct from v_hp) then
    raise exception '[127] prime highest_price basis % (n=%) does not reproduce 120''s survivor mean % (n=%)',
      v_row.avg_no_vig_clv_highest_price, v_row.clv_n_highest_price, v_hp, v_hp_n;
  end if;

  raise notice '[127] OK — every published band carries clv_basis=first_detection and both bases reproduce independently';
end $$;

commit;
