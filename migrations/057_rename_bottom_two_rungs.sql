-- ============================================================================
-- 057 — NOTED → TRACE, NOISE → NIL. The bottom two rungs of the one ladder.
--
-- WHY, AND IT IS NOT A STYLE PREFERENCE. A rung has exactly one job: tell a
-- reader HOW MUCH is there. NOTED did not — it described what WE did with the
-- row ("we noted it"), which is a fact about our filing system and not about
-- the signal. NOISE was technically precise (a disagreement inside the model's
-- own error bar IS noise) but it is the harshest word on the page and it made
-- the bottom rung read as a verdict on the fixture rather than a measurement.
--
-- TRACE and NIL are quantities, and they read as a pair: a trace of a
-- disagreement, or none of one. The step between them is legible without
-- consulting the cutoffs, which is the property NOTED/NOISE never had.
--
-- PRIME 65+ and WATCH 40–64 are UNCHANGED. Only the two words move; no cutoff,
-- no score and no row's meaning changes. `maxedge_score()` is not touched.
--
-- WHAT THIS TOUCHES, ESTABLISHED BY ASKING THE DATABASE rather than by reading
-- 048 and 056 — the standing rule in this repo after three claims about the
-- schema turned out stale on 6 Aug. A catalogue sweep over views, routines,
-- constraints and column defaults for either word returns exactly two objects:
--
--     routine     public.maxedge_band
--     constraint  value_signals.value_signals_mxs_band_check
--
-- and one column of data, `value_signals.mxs_band`, holding 49 NOTED and 321
-- NOISE against 64 WATCH, 22 PRIME and 34 null. `board_signals` calls the
-- function but does not spell the words, so CREATE OR REPLACE reaches it for
-- free; the signature is unchanged so no view has to be rebuilt.
--
-- ORDER IS LOAD-BEARING. The constraint comes off FIRST: 056 bounds the column
-- to the four old words, so an UPDATE that writes TRACE into it fails on the
-- first row while the old CHECK is still in place. Function, then data, then
-- the new CHECK, then the assertions.
--
-- IDEMPOTENT. Every step is guarded, so a re-run against an already-migrated
-- database is a no-op rather than an error.
-- ============================================================================

begin;

-- ── 1. Take the old bound off ────────────────────────────────────────────────
alter table public.value_signals
  drop constraint if exists value_signals_mxs_band_check;

-- ── 2. The classifier says the new words ─────────────────────────────────────
-- Mirrors eve-frontend/lib/maxedge.ts maxedgeBand() and
-- eve-engine/lib/signalTier.js bandFor(). All three are the same cutoffs; if
-- one changes, all three change. 65 is the selection boundary BY CONSTRUCTION —
-- maxedge_score() is 100·(1 − 0.35^(z/z_gate)), which is exactly 65 at
-- z = z_gate. Nothing chooses it, and nothing here may.
create or replace function public.maxedge_band(p_mxs integer)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_mxs is null then null
    when p_mxs >= 65 then 'PRIME'      -- backed
    when p_mxs >= 40 then 'WATCH'      -- real, but not backed
    when p_mxs >= 25 then 'TRACE'      -- a trace of a disagreement
    else                  'NIL' end;   -- inside our own error bars
$$;

comment on function public.maxedge_band(integer) is
  'MaxEdgeScore → rung. PRIME 65+ | WATCH 40-64 | TRACE 25-39 | NIL 0-24. '
  'A NULL score returns NULL, never NIL: "we could not score this" and "we '
  'scored it and found nothing" are different statements and the UI draws them '
  'differently — an absent badge against a ◇ NIL one. Renamed from '
  'NOTED/NOISE in migration 057; the cutoffs did not move.';

-- ── 3. Rewrite the stored rungs ──────────────────────────────────────────────
-- The column is a frozen verdict, not a derived value, so it has to be written
-- rather than recomputed. Recomputing from mxs would ALSO silently re-band any
-- row whose stored band disagreed with its score, which is a different change
-- smuggled in under a rename. 056 verified those agree today; this migration
-- does not get to rely on that a second time.
update public.value_signals set mxs_band = 'TRACE' where mxs_band = 'NOTED';
update public.value_signals set mxs_band = 'NIL'   where mxs_band = 'NOISE';

-- ── 4. Bound the column again ────────────────────────────────────────────────
-- A free-text column filled by a function is fine right up until something
-- writes STRONG into it. Guarded so a re-run does not fail on the existing one.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.value_signals'::regclass
      and conname  = 'value_signals_mxs_band_check'
  ) then
    alter table public.value_signals
      add constraint value_signals_mxs_band_check
      check (mxs_band = any (array['PRIME'::text, 'WATCH'::text, 'TRACE'::text, 'NIL'::text]));
  end if;
end $$;

-- ── 5. Assert, inside the transaction ────────────────────────────────────────
-- 056 probed its constraints rather than reasoning about them, and found a real
-- gap doing it. Same discipline: if any of these fail the whole thing rolls
-- back and nothing is half-renamed.
do $$
declare
  n_old   integer;
  n_bad   integer;
  fn_word text;
begin
  select count(*) into n_old
    from public.value_signals where mxs_band in ('NOTED', 'NOISE');
  if n_old > 0 then
    raise exception '057: % row(s) still carry a retired rung', n_old;
  end if;

  select count(*) into n_bad
    from public.value_signals
   where mxs_band is not null
     and mxs_band not in ('PRIME', 'WATCH', 'TRACE', 'NIL');
  if n_bad > 0 then
    raise exception '057: % row(s) outside the four rungs', n_bad;
  end if;

  -- The function and the column must agree, or a row written tomorrow lands
  -- outside the CHECK the moment the engine calls maxedge_band().
  select public.maxedge_band(30) into fn_word;
  if fn_word <> 'TRACE' then
    raise exception '057: maxedge_band(30) returned %, expected TRACE', fn_word;
  end if;
  select public.maxedge_band(10) into fn_word;
  if fn_word <> 'NIL' then
    raise exception '057: maxedge_band(10) returned %, expected NIL', fn_word;
  end if;
  if public.maxedge_band(null) is not null then
    raise exception '057: maxedge_band(null) must stay null, never a rung';
  end if;
end $$;

commit;

-- ── Verify after applying ────────────────────────────────────────────────────
--   select mxs_band, count(*) from value_signals group by 1 order by 2 desc;
--   -- expect only PRIME / WATCH / TRACE / NIL and null
--
--   -- and prove the bound still bites (roll this back):
--   begin;
--     update value_signals set mxs_band = 'NOTED' where id = (select id from value_signals limit 1);
--   rollback;   -- expect: violates check constraint "value_signals_mxs_band_check"
