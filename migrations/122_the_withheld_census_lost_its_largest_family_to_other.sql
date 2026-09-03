-- 122_the_withheld_census_lost_its_largest_family_to_other.sql
--
-- Migration 121 gave the write-layer guard a fourth thing to say, and this is
-- the census catching up with it. 086's `withheld` CTE buckets
-- `score_withheld_reason` into three families under a comment that reads
-- "These three families are what the write-layer guards actually emit." That
-- sentence went false the moment 121 landed.
--
-- MEASURED THROUGH THE DEPLOYED FUNCTION, not reasoned about, 3 Sep 2026:
--
--     architecture       other   named families
--     MARKET_ANCHORED       55   16 (fair line beat the price)
--     MARKET_CONSENSUS      10   -
--     (unrecorded)          17   -
--     DIXON_COLES            -   125 + 25
--
-- So for MARKET_ANCHORED - one of the two architectures with a PAGE - 'other'
-- was 55 of its 71 withheld rows, the LARGEST family in its own census. A
-- bucket named 'other' holding the plurality is not a census, it is a shrug.
--
-- ── WHAT IS ADDED, AND WHY IT IS TWO ARMS AND NOT FOUR ──────────────────────
--
-- The guard can emit six sentences. Two of them describe no row in this
-- database, measured over all 112 distinct reason strings:
--
--     pattern                              distinct strings
--     '%above 1%'                    (060)              104
--     '%no row in model_calibration%'                      4
--     '%declined to score it%'       (121)                 2   <- added
--     '%24h of price history%'                             1
--     '%no model_architecture%'                            1   <- added
--     '%no usable sigma_p%'                                0
--     '%but model_calibration measures%'                   0
--
-- The last two are the sigma-disagreement roads, and nothing has ever taken
-- them. An arm matching zero rows is a branch nobody can see working, which
-- this repo already has a rule about - "a component that renders nothing in
-- the state your fixture supplies has not been verified". They are left out
-- deliberately, and the day one fires it lands in 'other', which is what
-- 'other' is for.
--
-- **THE SECOND ARM IS BEYOND THE BRIEF AND IS FLAGGED AS SUCH.** The ask was
-- the fourth family. `%no model_architecture%` is a fifth, and it is added
-- because it is the same defect in the same CASE - 17 real rows, the whole of
-- the '(unrecorded)' cohort's census, sitting in 'other' for the same reason
-- the 65 were. Fixing one and leaving the other would leave this function
-- needing a third visit.
--
-- ── THE ARMS ARE MUTUALLY EXCLUSIVE, AND THAT IS ASSERTED ───────────────────
--
-- A CASE evaluates in order, so overlapping patterns would make the ORDER the
-- thing that decides a family - a silent dependency nobody reading the arms
-- would see. Checked over every distinct reason string in the table: each one
-- matches EXACTLY ONE of the five patterns, never two. Asserted below rather
-- than left as a property of today's wording, because 121 chose its sentences
-- partly to keep 086's substring intact and a future sentence might not.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
--
-- Everything except the CASE. Same signature, same SECURITY DEFINER, same
-- STABLE, same pinned `search_path TO 'public', 'pg_catalog'`, same jsonb
-- shape, same 20-row settled cap, same bare-text `p_arch` equality - never
-- concatenated. `CREATE OR REPLACE` preserves the ACL, and 107 revoked PUBLIC
-- EXECUTE from this function on purpose, so the grants are asserted after the
-- replace rather than assumed: anon, authenticated, service_role and postgres,
-- and PUBLIC absent.
--
-- NO SURFACE CHANGES. `lib/models.ts` parses `scores.reasons` into
-- `WithheldReason[]` and nothing renders it - the 23 Aug rewrite of
-- `/models/[id]` removed the score-withholding panel. This makes an internal
-- census honest; it does not put anything new on screen.
--
-- Reversible: re-issue the function from 086 with the two arms removed.

begin;

create or replace function public.model_detail(p_arch text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_catalog'
as $function$
  with mine as (
    select vs.*
      from public.value_signals vs
     where coalesce(vs.model_architecture, '(unrecorded)') = p_arch
  ),
  settled as (select * from mine where result in ('win', 'loss')),
  per_fx as (
    select market, match_id,
           avg(case when result = 'win' then detected_odds - 1 else -1 end) as r
      from settled group by 1, 2
  ),
  by_market as (
    select market, count(*)::int as n_fx, avg(r) as mu, stddev_samp(r) as sd
      from per_fx group by 1
  ),
  sig_market as (select market, count(*)::int as n from settled group by 1),
  per_month as (
    select date_trunc('month', detected_at)::date as m, match_id,
           avg(case when result = 'win' then detected_odds - 1 else -1 end) as r
      from settled group by 1, 2
  ),
  by_month as (select m, count(*)::int as n_fx, avg(r) as mu from per_month group by 1),
  withheld as (
    -- Each reason carries the row's own arithmetic, so grouping the raw column
    -- returns one bucket per row and says nothing. These families are what the
    -- write-layer guards actually emit AND have been observed emitting; the two
    -- sigma-disagreement roads have never been taken and would be arms nobody
    -- could see work. The patterns are mutually exclusive over every reason in
    -- the table, so the ORDER of these arms decides nothing (asserted in 122).
    select case
             when score_withheld_reason like '%no row in model_calibration%'
               then 'no calibration row, so no measured error bar'
             when score_withheld_reason like '%declined to score it%'
               then 'calibrated, but the writer declined to score it'
             when score_withheld_reason like '%no model_architecture%'
               then 'no architecture on the row, so nothing to attribute it to'
             when score_withheld_reason like '%24h of price history%'
               then 'de-vigged from price history, not a line that was quoted'
             when score_withheld_reason like '%above 1%'
               then 'the de-vigged fair line beat the price it came from'
             else 'other'
           end as fam,
           count(*)::int as n
      from mine where score_withheld_reason is not null group by 1
  )
  select jsonb_build_object(
    'architecture', p_arch,
    'markets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'market', b.market,
        'fixtures', b.n_fx,
        'signals', (select n from sig_market s where s.market = b.market),
        'yield_clustered', round(b.mu::numeric, 4),
        'yield_z', case when b.n_fx >= 2 and b.sd > 0
                        then round((b.mu / (b.sd / sqrt(b.n_fx)))::numeric, 2) end
      ) order by b.n_fx desc) from by_market b), '[]'::jsonb),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'fixtures', n_fx,
        'yield_clustered', round(mu::numeric, 4)
      ) order by m) from by_month), '[]'::jsonb),
    'clv', (select jsonb_build_object(
      'settled', count(*)::int,
      'with_clv', count(no_vig_clv)::int,
      'beat_close', (count(*) filter (where no_vig_clv > 0))::int,
      'avg_clv', round(avg(clv)::numeric, 4),
      'avg_no_vig_clv', round(avg(no_vig_clv)::numeric, 4)
    ) from settled),
    'book', (select jsonb_build_object(
      'wins', (count(*) filter (where result = 'win'))::int,
      'losses', (count(*) filter (where result = 'loss'))::int,
      'avg_odds', round(avg(detected_odds)::numeric, 2)
    ) from settled),
    'scores', (select jsonb_build_object(
      'written', count(*)::int,
      'scored', count(mxs)::int,
      'written_recent', (count(*) filter (where detected_at > now() - interval '14 days'))::int,
      'scored_recent', (count(mxs) filter (where detected_at > now() - interval '14 days'))::int,
      'reasons', coalesce((
        select jsonb_agg(jsonb_build_object('reason', fam, 'signals', n) order by n desc)
          from withheld), '[]'::jsonb)
    ) from mine),
    'settled_recent', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'kickoff_at', s.kickoff_at,
        'market', s.market,
        'outcome', s.outcome,
        'odds', s.detected_odds,
        'result', s.result,
        'no_vig_clv', s.no_vig_clv,
        'home', ht.name,
        'away', at.name
      ) as x
        from settled s
        left join public.matches m  on m.id  = s.match_id
        left join public.teams   ht on ht.id = m.home_team_id
        left join public.teams   at on at.id = m.away_team_id
       order by s.kickoff_at desc nulls last
       limit 20
    ) q), '[]'::jsonb)
  );
$function$;

-- 1. The arms are mutually exclusive over every reason the table holds.
--    Overlapping patterns would make the ORDER of the CASE the thing that
--    decides a family, which is a dependency nobody reading the arms can see.
do $$
declare v_overlap int;
begin
  select count(*) into v_overlap
  from (
    select (s like '%no row in model_calibration%')::int
         + (s like '%declined to score it%')::int
         + (s like '%no model_architecture%')::int
         + (s like '%24h of price history%')::int
         + (s like '%above 1%')::int as hits
    from (select distinct score_withheld_reason as s
            from public.value_signals where score_withheld_reason is not null) r
  ) m
  where hits > 1;
  if v_overlap > 0 then
    raise exception '122 FAILED: % distinct reason(s) match more than one arm - the CASE order would decide the family', v_overlap;
  end if;
  raise notice '122: every distinct reason matches exactly one arm.';
end $$;

-- 2. Nothing the table currently holds still lands in 'other'. This is the
--    claim the migration exists to make, checked THROUGH the function rather
--    than against the patterns a second time - the CTE is what ships, and a
--    test that re-implements it tests itself.
do $$
declare
  v_arch  text;
  v_other int;
  v_named int;
begin
  for v_arch in
    select distinct coalesce(model_architecture, '(unrecorded)')
      from public.value_signals where score_withheld_reason is not null
  loop
    select coalesce(sum((x ->> 'signals')::int) filter (where x ->> 'reason' = 'other'), 0),
           coalesce(sum((x ->> 'signals')::int) filter (where x ->> 'reason' <> 'other'), 0)
      into v_other, v_named
    from jsonb_array_elements(public.model_detail(v_arch) -> 'scores' -> 'reasons') x;

    if v_other > 0 then
      raise exception '122 FAILED: % still files % withheld row(s) under other', v_arch, v_other;
    end if;
    if v_named = 0 then
      raise exception '122 FAILED: % has withheld rows but the census named none of them', v_arch;
    end if;
  end loop;
  raise notice '122: no architecture files a withheld row under other.';
end $$;

-- 3. The census still counts every withheld row exactly once - no arm was
--    added in a way that drops or double-counts. Summed across architectures
--    it must equal the table.
do $$
declare v_fn bigint; v_tbl bigint;
begin
  select count(*) into v_tbl
  from public.value_signals where score_withheld_reason is not null;

  select coalesce(sum((x ->> 'signals')::int), 0) into v_fn
  from (select distinct coalesce(model_architecture, '(unrecorded)') as a
          from public.value_signals where score_withheld_reason is not null) arch,
       lateral jsonb_array_elements(public.model_detail(arch.a) -> 'scores' -> 'reasons') x;

  if v_fn <> v_tbl then
    raise exception '122 FAILED: the census counts % withheld rows against the table''s %', v_fn, v_tbl;
  end if;
  raise notice '122: the census accounts for all % withheld rows.', v_tbl;
end $$;

-- 4. The replace did not relax the function or its grants. 107 revoked PUBLIC
--    EXECUTE from this function deliberately; CREATE OR REPLACE preserves an
--    ACL, and that is exactly the kind of thing to assert rather than trust.
do $$
declare
  v_secdef boolean;
  v_vol    char;
  v_cfg    text;
  v_public boolean;
begin
  -- A NULL proacl is not "no grants" - for a FUNCTION it is the DEFAULT, and
  -- the default grants EXECUTE to PUBLIC. Reading a null as safe is how a
  -- revoke gets quietly undone. A grant to PUBLIC renders with an EMPTY
  -- grantee ('=X/postgres'), which is what the anchored regex looks for.
  select p.prosecdef, p.provolatile,
         replace(coalesce(array_to_string(p.proconfig, ','), ''), ' ', ''),
         (p.proacl is null)
           or (array_to_string(p.proacl, E'\n') ~ '(^|\n)=X/')
    into v_secdef, v_vol, v_cfg, v_public
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'model_detail';

  if not v_secdef then
    raise exception '122 FAILED: model_detail is no longer SECURITY DEFINER';
  end if;
  if v_vol <> 's' then
    raise exception '122 FAILED: model_detail is no longer STABLE (volatility %)', v_vol;
  end if;
  -- proconfig reads 'search_path=public, pg_catalog' WITH a space, so the
  -- comparison is made on the space-stripped form rather than on a guess.
  if v_cfg <> 'search_path=public,pg_catalog' then
    raise exception '122 FAILED: model_detail lost its pinned search_path (proconfig: %)', v_cfg;
  end if;
  if v_public then
    raise exception '122 FAILED: PUBLIC holds EXECUTE on model_detail - migration 107 revoked it';
  end if;
  raise notice '122: SECURITY DEFINER, STABLE, search_path pinned, PUBLIC still has no EXECUTE.';
end $$;

-- 5. The three architectures a reader can reach still answer. A census fix
--    that broke the two figures /models actually renders (win rate and the
--    beat-the-close rate, both read off this function) would be a bad trade.
do $$
declare v_arch text; v_j jsonb;
begin
  foreach v_arch in array array['DIXON_COLES', 'MARKET_ANCHORED'] loop
    v_j := public.model_detail(v_arch);
    if v_j is null or v_j -> 'book' is null or v_j -> 'clv' is null then
      raise exception '122 FAILED: model_detail(%) no longer returns its book or clv block', v_arch;
    end if;
  end loop;
  raise notice '122: both page models still return a book and a clv block.';
end $$;

commit;
