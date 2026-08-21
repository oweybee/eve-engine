-- 089_prime_is_the_one_sigma_rung.sql
--
-- PRIME MOVES FROM 88 TO 65 AND STRONG IS RETIRED. Owner ruling, 21 Aug 2026.
--
-- THIS IS A VOCABULARY CHANGE AND NOT A RE-CUT, which is the whole of its
-- defence. Every surviving cutoff is untouched and every one is still a round
-- multiple of sigma — invert 100*(1 - 0.35^z) and 65/41/23/10 are z of
-- 1 / 0.5 / 0.25 / 0.1. What was removed is the 2-sigma BOUNDARY at 88, and
-- what moved is the WORD above the 1-sigma line.
--
-- WHY THE 88 RUNG WENT. It named a band nothing occupies. On the de-vigged
-- basis — the only basis this engine has written since migration 058 — the
-- highest score ever recorded is 83 over 300 rows, and the ten rows that ever
-- cleared 88 are legacy `gap_basis = 'implied'` rows where the gap restates the
-- price. Both PUBLISHING architectures are bounded far below it: measured
-- 21 Aug, MARKET_ANCHORED's widest gap ever is 4.58pp over 114 scored rows and
-- DIXON_COLES's is 5.09pp over 8, against the 6.06pp that 2 sigma requires at
-- their sigma of 0.0300. It was not a quiet week; it is structural.
--
-- So the ladder's top rung was a word no row could earn, while the word the
-- product actually published sat one rung down.
--
-- WHY STRONG IS RETIRED RATHER THAN RE-POINTED AT 41. Moving it down would put
-- an endorsement word on a band we decline to back, which is the 5 Aug ruling.
-- The settled record says the same thing — measured 21 Aug, de-vigged basis,
-- clustered by fixture, publishing architectures:
--
--     65-87 (1.0 sigma)    30 fixtures    -7.46%    z -0.33
--     41-64 (0.5 sigma)    96 fixtures    -6.22%    z -0.52
--
-- Neither is significant, and that is the point: there is no evidence the
-- 0.5-sigma band has earned a word that sounds like one.
--
-- NOT ONE ROW CHANGES SIDES. `isBacked` has always read the 65 cutoff rather
-- than the top word, in SQL, in the engine and in the browser. The free pick,
-- the Telegram broadcast gate and the live alert select exactly what they
-- selected yesterday. eve-frontend/lib/tierMonotonicity.test.ts asserts that
-- against the SCORE across all 101 values rather than against a rung name.
--
-- THE CHECK STILL ADMITS 'STRONG', DELIBERATELY, AND THAT IS THE DEPLOY GUARD.
-- This migration and the engine deploy land separately. If the constraint were
-- tightened to the five new words first, the still-running old `scoreSignal`
-- would write 'STRONG', the insert would be REJECTED, and a vocabulary change
-- would become an ingestion outage — the failure mode this repo has taken twice
-- from a guard that raised instead of degrading. The browser reads a stored
-- 'STRONG' forward to PRIME (lib/semantics LEGACY_RUNG), so both words render
-- correctly for as long as both exist. A follow-up migration drops 'STRONG'
-- once the engine deploy has landed and `select count(*) from value_signals
-- where mxs_band = 'STRONG' and detected_at > <deploy>` reads zero.
--
-- Reversible: the previous maxedge_band() body is in migration 048, and the
-- band rewrite below is `update value_signals set mxs_band = 'STRONG' where
-- mxs_band = 'PRIME' and mxs < 88`.

begin;

-- ── 1. The function. Same cutoffs, one fewer boundary, one moved word ────────

create or replace function public.maxedge_band(p_mxs integer)
 returns text
 language sql
 immutable parallel safe
 set search_path to 'public', 'pg_catalog'
as $function$
  select case
    when p_mxs is null then null
    when p_mxs >= 65 then 'PRIME'      -- 1.00 sigma, backed. Was STRONG until
                                       -- 21 Aug 2026; the 2.00 sigma rung above
                                       -- it named a band no row has occupied.
    when p_mxs >= 41 then 'WATCH'      -- 0.50 sigma
    when p_mxs >= 23 then 'SLIGHT'     -- 0.25 sigma
    when p_mxs >= 10 then 'TRACE'      -- 0.10 sigma
    else                  'NIL' end;   -- inside our own error bars
$function$;

comment on function public.maxedge_band is
  'The conviction rung for a MaxEdgeScore. Five rungs since 21 Aug 2026: '
  'PRIME (1 sigma, the backed line) / WATCH / SLIGHT / TRACE / NIL, cut at '
  '65 / 41 / 23 / 10 — every one a round multiple of sigma. Mirrors BAND_MIN in '
  'eve-engine/lib/signalTier.js and eve-frontend/lib/maxedge.ts.';

-- ── 2. The constraint, widened to hold both words during the deploy window ──

alter table public.value_signals drop constraint if exists value_signals_mxs_band_check;
alter table public.value_signals add constraint value_signals_mxs_band_check
  check (mxs_band = any (array['PRIME','WATCH','SLIGHT','TRACE','NIL','STRONG']));

-- ── 3. Stored history, rewritten to the words the ladder now has ────────────
--
-- 57 rows read 'STRONG' and every one of them scored 65-84, so every one is
-- PRIME under the new ladder — the band is the SAME BAND and only its name
-- changed. The 10 rows reading 'PRIME' scored 92-99 and stay PRIME: they also
-- cleared 65, so nothing is promoted and no claim grows.
--
-- Derived from `maxedge_band(mxs)` rather than a literal map, so the rewrite
-- cannot disagree with the function it is supposed to mirror.

update public.value_signals
set mxs_band = public.maxedge_band(mxs)
where mxs is not null
  and mxs_band is distinct from public.maxedge_band(mxs);

-- ── 4. Assertions, before this commits ─────────────────────────────────────
do $$
declare v_bad bigint; v_strong bigint; v_backed_before bigint; v_backed_after bigint;
begin
  -- The function cuts where it says it cuts.
  if public.maxedge_band(65) <> 'PRIME'  then raise exception '089: 65 is not PRIME'; end if;
  if public.maxedge_band(64) <> 'WATCH'  then raise exception '089: 64 is not WATCH'; end if;
  if public.maxedge_band(88) <> 'PRIME'  then raise exception '089: 88 is not PRIME'; end if;
  if public.maxedge_band(99) <> 'PRIME'  then raise exception '089: 99 is not PRIME'; end if;
  if public.maxedge_band(41) <> 'WATCH'  then raise exception '089: 41 is not WATCH'; end if;
  if public.maxedge_band(23) <> 'SLIGHT' then raise exception '089: 23 is not SLIGHT'; end if;
  if public.maxedge_band(10) <> 'TRACE'  then raise exception '089: 10 is not TRACE'; end if;
  if public.maxedge_band(9)  <> 'NIL'    then raise exception '089: 9 is not NIL'; end if;
  if public.maxedge_band(null) is not null then raise exception '089: null scored a rung'; end if;

  -- No stored 'STRONG' survives the rewrite.
  select count(*) into v_strong from public.value_signals where mxs_band = 'STRONG';
  if v_strong <> 0 then
    raise exception '089: % rows still read STRONG after the rewrite', v_strong;
  end if;

  -- Every stored band agrees with the function.
  select count(*) into v_bad from public.value_signals
   where mxs is not null and mxs_band is distinct from public.maxedge_band(mxs);
  if v_bad <> 0 then raise exception '089: % stored bands disagree with maxedge_band()', v_bad; end if;

  -- AND THE BACKED SET IS UNCHANGED. This is the assertion the whole ruling
  -- rests on: the same rows are backed before and after, because the 65 line
  -- never moved. Counted from the SCORE on both sides so a rung rename cannot
  -- make it trivially true.
  select count(*) into v_backed_before from public.value_signals where mxs >= 65;
  select count(*) into v_backed_after  from public.value_signals
   where mxs_band = 'PRIME';
  if v_backed_before <> v_backed_after then
    raise exception '089: backed set moved — % scores at or above 65 but % rows read PRIME',
      v_backed_before, v_backed_after;
  end if;
end $$;

commit;
