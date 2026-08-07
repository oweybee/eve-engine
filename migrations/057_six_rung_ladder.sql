-- ============================================================================
-- 057 — The conviction ladder goes to six rungs.
--
--     PRIME  88-99   >= 2.00 sigma
--     STRONG 65-87   >= 1.00 sigma   <- the selection boundary, by construction
--     WATCH  41-64   >= 0.50 sigma
--     SLIGHT 23-40   >= 0.25 sigma
--     TRACE  10-22   >= 0.10 sigma
--     NIL     0-9    <  0.10 sigma
--
-- SUPERSEDES the NOTED->TRACE / NOISE->NIL migration written earlier the same
-- day and never applied. Two passes over the same 370 rows to reach one end
-- state is two chances to half-apply it; this is the single hop.
--
-- NOT ONE CUTOFF IS A ROUND NUMBER SOMEBODY LIKED. maxedge_score() is
-- 100*(1 - 0.35^z) with z the probability gap measured in the architecture's own
-- error bars, so inverting it puts every boundary on a round multiple of sigma:
-- 2.00 -> 87.75 -> 88, 1.00 -> 65.00 -> 65, 0.50 -> 40.84 -> 41,
-- 0.25 -> 23.08 -> 23, 0.10 -> 9.97 -> 10. The old 40 and 25 were chosen; 41
-- and 23 are where those sigmas actually fall. 65 is unchanged and still falls
-- out of the base: at z = z_gate the expression is 1 - 0.35 = 0.65 exactly.
--
-- TWO RUNGS ARE BACKED NOW, and that is what makes STRONG sayable at all. The
-- 5 Aug ruling forbids calling a reading "Strong" when we have DECLINED to back
-- it; at or above the 1 sigma line we have not declined. Everything below 65
-- keeps a neutral quantity word for exactly the reason it always did.
--
-- READ THE TABLE, NOT THE MIGRATION. What this touches was established by
-- sweeping the catalogue for the old words rather than by reading 048 and 056 —
-- exactly one routine (maxedge_band), one constraint
-- (value_signals_mxs_band_check) and one column (value_signals.mxs_band).
-- board_signals calls the function but does not spell the words, and the
-- signature is unchanged, so CREATE OR REPLACE reaches it without a rebuild.
--
-- ORDER IS LOAD-BEARING. The constraint comes off FIRST: 056 bounds the column
-- to the four old words, so an UPDATE writing STRONG fails on the first row
-- while it stands. Function, then data, then the new bound, then assertions.
--
-- IDEMPOTENT: every step is guarded, so a re-run is a no-op.
-- ============================================================================

begin;

-- 1. Take the old bound off ---------------------------------------------------
alter table public.value_signals
  drop constraint if exists value_signals_mxs_band_check;

-- 2. The classifier says the six words ----------------------------------------
-- Mirrors eve-frontend/lib/maxedge.ts BAND_MIN and eve-engine/lib/signalTier.js.
-- All three are the same table; a fourth copy is how a band and a score drift.
create or replace function public.maxedge_band(p_mxs integer)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_mxs is null then null
    when p_mxs >= 88 then 'PRIME'      -- 2.00 sigma, backed
    when p_mxs >= 65 then 'STRONG'     -- 1.00 sigma, backed
    when p_mxs >= 41 then 'WATCH'      -- 0.50 sigma
    when p_mxs >= 23 then 'SLIGHT'     -- 0.25 sigma
    when p_mxs >= 10 then 'TRACE'      -- 0.10 sigma
    else                  'NIL' end;   -- inside our own error bars
$$;

comment on function public.maxedge_band(integer) is
  'MaxEdgeScore -> rung. PRIME 88+ | STRONG 65-87 | WATCH 41-64 | SLIGHT 23-40 '
  '| TRACE 10-22 | NIL 0-9. Every cutoff is a round multiple of sigma, not a '
  'round decimal: 2.00 / 1.00 / 0.50 / 0.25 / 0.10. PRIME and STRONG are the '
  'backed rungs — test with the cutoff, never with = ''PRIME'', or the backing '
  'line silently moves from 65 to 88. A NULL score returns NULL, never NIL: '
  '"could not score" and "scored it and found nothing" are different statements '
  'and the UI draws them differently.';

-- 3. Re-band the stored rows --------------------------------------------------
-- RECOMPUTED here, unlike a pure rename: the cutoffs moved, so the old word no
-- longer determines the new one (a stored WATCH is now WATCH or SLIGHT
-- depending on its score). Rows whose mxs is null keep a null band and are left
-- alone — there is nothing to recompute from, and inventing one would be the
-- "scored it and found nothing" lie the function itself refuses.
update public.value_signals
   set mxs_band = public.maxedge_band(mxs)
 where mxs is not null
   and mxs_band is distinct from public.maxedge_band(mxs);

-- 4. Bound the column again ---------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.value_signals'::regclass
      and conname  = 'value_signals_mxs_band_check'
  ) then
    alter table public.value_signals
      add constraint value_signals_mxs_band_check
      check (mxs_band = any (array[
        'PRIME'::text, 'STRONG'::text, 'WATCH'::text,
        'SLIGHT'::text, 'TRACE'::text, 'NIL'::text]));
  end if;
end $$;

-- 5. Assert, inside the transaction -------------------------------------------
-- 056 probed its constraints rather than reasoning about them and found a real
-- gap doing it. Same discipline: any failure rolls the whole thing back rather
-- than leaving the ladder half-cut.
do $$
declare
  n_bad  integer;
  n_drift integer;
begin
  select count(*) into n_bad
    from public.value_signals
   where mxs_band is not null
     and mxs_band not in ('PRIME','STRONG','WATCH','SLIGHT','TRACE','NIL');
  if n_bad > 0 then
    raise exception '057: % row(s) outside the six rungs', n_bad;
  end if;

  -- The stored verdict and the function must agree, or a row written tomorrow
  -- lands outside its own constraint.
  select count(*) into n_drift
    from public.value_signals
   where mxs is not null
     and mxs_band is distinct from public.maxedge_band(mxs);
  if n_drift > 0 then
    raise exception '057: % row(s) disagree with maxedge_band(mxs)', n_drift;
  end if;

  -- Every boundary, from the sigma it is derived from.
  if public.maxedge_band(88) <> 'PRIME'  then raise exception '057: 88 is not PRIME'; end if;
  if public.maxedge_band(87) <> 'STRONG' then raise exception '057: 87 is not STRONG'; end if;
  if public.maxedge_band(65) <> 'STRONG' then raise exception '057: 65 is not STRONG'; end if;
  if public.maxedge_band(64) <> 'WATCH'  then raise exception '057: 64 is not WATCH'; end if;
  if public.maxedge_band(41) <> 'WATCH'  then raise exception '057: 41 is not WATCH'; end if;
  if public.maxedge_band(40) <> 'SLIGHT' then raise exception '057: 40 is not SLIGHT'; end if;
  if public.maxedge_band(23) <> 'SLIGHT' then raise exception '057: 23 is not SLIGHT'; end if;
  if public.maxedge_band(22) <> 'TRACE'  then raise exception '057: 22 is not TRACE'; end if;
  if public.maxedge_band(10) <> 'TRACE'  then raise exception '057: 10 is not TRACE'; end if;
  if public.maxedge_band(9)  <> 'NIL'    then raise exception '057: 9 is not NIL';    end if;
  if public.maxedge_band(null) is not null then
    raise exception '057: maxedge_band(null) must stay null, never a rung';
  end if;
end $$;

commit;

-- Verify after applying -------------------------------------------------------
--   select mxs_band, count(*) from value_signals group by 1 order by 2 desc;
--   -- expect only PRIME / STRONG / WATCH / SLIGHT / TRACE / NIL and null
--
--   -- and prove the bound still bites (roll this back):
--   begin;
--     update value_signals set mxs_band = 'NOTED' where id = (select id from value_signals limit 1);
--   rollback;   -- expect: violates check constraint "value_signals_mxs_band_check"
