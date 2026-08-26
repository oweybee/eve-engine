
-- 102 — the ladder becomes yield-calibrated: PRIME / EDGE / WATCH / SLIGHT /
-- TRACE / NIL, and THE BOX PICKS THE RUNG while the score can only demote.
--
-- APPLIED AND VERIFIED IN PRODUCTION, 26 Aug 2026 (ledger 20260826144918).
-- Verified from the database rather than from the success flag: maxedge_band(60)
-- is PRIME and (59) is WATCH, f(0.04)=0.68 and f(0.08)=0.85, and the six rung
-- cases all return what the runbook publishes. The two widened constraints were
-- probed on a temp table built `like public.value_signals including
-- constraints`, so the CHECKs under test are the live ones and not a hand-copy:
-- of four inserts exactly ONE was accepted — the shape the engine now writes
-- (mes_basis 'yield_calibrated' + signal_category 'edge') — while mxs_band
-- 'EDGE', an invented basis and an invented category were all refused. The
-- positive control ran first, so the three refusals mean denial and not a test
-- that never ran.
--
-- NO ROW WAS REWRITTEN, and the proof is on the table: 56 rows scoring 60-64
-- still carry the stored band WATCH the 65 cut gave them, where the new
-- function would say PRIME. `mes_basis` is what tells the two definitions
-- apart. 1,262 rows total, 0 on the new basis and 0 in the edge bucket until
-- the engine build deploys.
--
-- Owner ruling, 26 Aug 2026, on the settled book to 25 Aug. This is the SQL
-- third of a three-part release: `eve-engine/lib/signalTier.js`, this file, and
-- `eve-frontend/lib/maxedge.ts` are three copies of ONE table and land together
-- or not at all. Migration 093 records what happened the last time one moved
-- alone — the homepage printed `◆ PRIME · 65` under a header reading NOTHING
-- BACKED TODAY.
--
-- THE ONE IDEA. Until now the printed rung came from the SCORE, and f(edge) was
-- bent until the score agreed with the eligibility box. The settled record says
-- that was backwards: the score's top three rungs are indistinguishable from
-- each other (+3.2% / +3.7% / +9.0%, all inside noise) while the EDGE BAND
-- separates cleanly — 5.0-6.9% returns +32.7% (z 1.72), 7.0-9.9% returns
-- +18.5%, and below 5% returns -11.9% at clustered z -1.51 over 163 fixtures.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO CHECK CONSTRAINTS HAD TO BE WIDENED OR THIS RELEASE IS AN OUTAGE, AND
-- NEITHER IS IN THE RUNBOOK. Found by probing the live constraints rather than
-- by reading the deploy note.
--
--   `value_signals_mes_basis_check` admits ('raw_sigma','edge_adjusted'). The
--   engine now stamps `mes_basis = 'yield_calibrated'` on EVERY scored row via
--   `scoreSignal`, so without this widening EVERY value_signals INSERT fails —
--   a 100% ingestion outage, not merely a missing rung. supabase-js resolves
--   with `{ error }` rather than throwing, which is exactly how the unchecked
--   webhook write went unnoticed for a fortnight.
--
--   `value_signals_signal_category_check` admits ('prime','value','longshot').
--   `categoryFor` now returns 'edge' as a fourth bucket, written from FIVE call
--   sites (computeValues, computeApiValues, computeInplayValues x2,
--   computeModelBoard). Without this widening every EDGE signal is rejected.
--
-- `value_signals_mxs_band_check` is DELIBERATELY NOT widened. `mxs_band` is the
-- SCORE band and EDGE is a BOX rung — `maxedge_band()` cannot return it and
-- neither can the engine's `bandFor`. Admitting it there would blur the exact
-- distinction this release rests on. Asserted below rather than assumed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK. `edge_efficiency` and `maxedge_band` are create-or-replace: re-apply
-- 093_edge_efficiency_ramp_3pct.sql and the `maxedge_band` body from
-- 048_maxedge_score.sql. `signal_rung` and `cap_at_watch` are new — drop them.
-- The two constraints widen a set and never narrow one, so leaving them is safe
-- and reverting them is only correct once no row carries the new values.
--
-- NO STORED ROW IS REWRITTEN. `mes_basis` distinguishes the definitions so
-- history is never averaged across the redefinition — the rule 058 set for
-- `gap_basis`. Settled rows keep the score and band they were written with.

begin;

-- ── f(edge) ────────────────────────────────────────────────────────────────
-- THE THREE CLIFFS SIT ON BOX BOUNDARIES AND THAT IS DELIBERATE: 0.75 -> 1.00
-- at 5%, 1.00 -> 0.85 at 7%, 0.85 -> shoulder at 10%. A smooth curve would imply
-- the bands shade into each other. They do not — they are different populations
-- with different realised yields, and the box cuts hard at exactly these points.
--
-- Boundary strictness mirrors the JS exactly: `<` at every seam, `<= 0` at the
-- foot. An off-by-one on a boundary here is a row that scores differently in
-- Postgres than in Node, which is the whole failure this file exists to prevent.
create or replace function public.edge_efficiency(p_edge numeric)
returns numeric
language sql
immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $function$
  select case
    when p_edge is null  then 1.0
    when p_edge <= 0     then 0.40
    when p_edge <  0.05  then 0.40 + (p_edge / 0.05) * 0.35
    when p_edge <  0.07  then 1.00
    when p_edge <  0.10  then 0.85
    when p_edge <  0.12  then 0.85 - ((p_edge - 0.10) / 0.02) * 0.45
    else                      0.25
  end::numeric;
$function$;

comment on function public.edge_efficiency(numeric) is
  'Yield-calibrated edge efficiency, 26 Aug 2026. Mirrors EDGE_EFFICIENCY in '
  'eve-engine/lib/maxedge.js and eve-frontend/lib/maxedge.ts. No longer decides a '
  'RUNG — signal_rung() does — it only keeps the displayed NUMBER honest about '
  'which band a row sits in.';

-- ── the score band ─────────────────────────────────────────────────────────
-- 65 -> 60. NOT a round multiple of sigma any more, and that is the point: the
-- old cutoffs inverted 100*(1 - 0.35^z) because the SCORE was the selector. It
-- is not any more, so these lines do one job — say how well a row must read to
-- KEEP the rung its box earned. 60 is chosen, not derived, and is documented as
-- chosen. 12 of 25 in-box rows clear 60; at 65 it was a handful.
create or replace function public.maxedge_band(p_mxs integer)
returns text
language sql
immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $function$
  select case
    when p_mxs is null then null
    when p_mxs >= 60 then 'PRIME'
    when p_mxs >= 41 then 'WATCH'
    when p_mxs >= 23 then 'SLIGHT'
    when p_mxs >= 10 then 'TRACE'
    else                  'NIL' end;
$function$;

-- ── the cap ────────────────────────────────────────────────────────────────
-- NOT `least(p_band, 'WATCH')`. Text comparison is alphabetical and 'PRIME'
-- sorts BEFORE 'WATCH', so `least()` returns 'PRIME' and silently lets an
-- out-of-box row keep the top word. The JS mirror carries the same warning
-- against `[band,'WATCH'].sort()[0]`, which fails identically.
create or replace function public.cap_at_watch(p_band text)
returns text
language sql
immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $function$
  select case when p_band = 'PRIME' then 'WATCH' else p_band end;
$function$;

comment on function public.cap_at_watch(text) is
  'Cap a SCORE band at WATCH. Never spell this as least(band, ''WATCH'') — '
  '''PRIME'' sorts before ''WATCH'' alphabetically, so least() returns PRIME and '
  'the cap silently does nothing.';

-- ── the rung ───────────────────────────────────────────────────────────────
-- THE WORD THE PRODUCT PRINTS. Mirrors `rungFor()` in eve-engine/lib/signalTier.js
-- and eve-frontend/lib/maxedge.ts.
--
-- The box picks the rung; the score can only demote. A row cannot be promoted
-- into a backed rung by scoring well outside the box, and a row inside the box
-- that reads badly drops rather than keeping a word it has not earned.
--
-- A null mxs returns NULL, never 'NIL' — "we could not score it" and "we scored
-- it and found nothing" are different statements and the frontend draws them
-- differently.
create or replace function public.signal_rung(
  p_odds numeric,
  p_edge numeric,
  p_mxs  integer
)
returns text
language sql
immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $function$
  select case
    when p_mxs is null or p_odds is null or p_edge is null then null

    -- PRIME box: odds [1.40, 3.00), edge [5.0%, 7.0%)
    when p_odds >= 1.40 and p_odds < 3.00
     and p_edge >= 0.05 and p_edge < 0.07 then
      case when p_mxs >= 60 then 'PRIME'
           when p_mxs >= 41 then 'EDGE'
           else public.maxedge_band(p_mxs) end

    -- EDGE box: odds [1.40, 3.00), edge [7.0%, 10.0%). Never PRIME, however it
    -- scores — the band's no-vig CLV is -2.02% against PRIME's +0.86%.
    when p_odds >= 1.40 and p_odds < 3.00
     and p_edge >= 0.07 and p_edge < 0.10 then
      case when p_mxs >= 41 then 'EDGE'
           else public.maxedge_band(p_mxs) end

    else public.cap_at_watch(public.maxedge_band(p_mxs))
  end;
$function$;

comment on function public.signal_rung(numeric, numeric, integer) is
  'The printed rung. THE BOX PICKS IT AND THE SCORE CAN ONLY DEMOTE. Mirrors '
  'rungFor() in eve-engine/lib/signalTier.js and eve-frontend/lib/maxedge.ts — '
  'three copies of one table, which must move together. Null mxs returns null, '
  'never NIL.';

-- ── the two constraints this release cannot ship without ───────────────────
alter table public.value_signals
  drop constraint if exists value_signals_mes_basis_check;
alter table public.value_signals
  add  constraint value_signals_mes_basis_check
  check (mes_basis is null or mes_basis in ('raw_sigma', 'edge_adjusted', 'yield_calibrated'));

alter table public.value_signals
  drop constraint if exists value_signals_signal_category_check;
alter table public.value_signals
  add  constraint value_signals_signal_category_check
  check (signal_category is null or signal_category in ('prime', 'edge', 'value', 'longshot'));

do $$
declare
  v_rung text;
  v_prev int;
  v_rank int;
  v_order text[] := array['NIL','TRACE','SLIGHT','WATCH','EDGE','PRIME'];
  o numeric; e numeric; m int;
begin
  -- f(edge): the runbook's three published values, exactly.
  assert public.edge_efficiency(0.04) = 0.68, 'f(0.04) must be 0.68';
  assert public.edge_efficiency(0.06) = 1.00, 'f(0.06) must be 1.00';
  assert public.edge_efficiency(0.08) = 0.85, 'f(0.08) must be 0.85';
  -- and the seams, where an off-by-one between SQL and JS would hide.
  assert public.edge_efficiency(0.0699) = 1.00, 'f is 1.00 up to but not at 7%';
  assert public.edge_efficiency(0.07)   = 0.85, 'the 7% cliff';
  assert public.edge_efficiency(0.0999) = 0.85, 'f holds 0.85 to but not at 10%';
  assert public.edge_efficiency(0.15)   = 0.25, 'the trap';
  assert public.edge_efficiency(null)   = 1.0,  'an unknown edge is not a zero edge';
  assert public.edge_efficiency(0.049) < 1,     'a decay, never a boost';

  -- the score band
  assert public.maxedge_band(62) = 'PRIME', 'maxedge_band(62) must be PRIME';
  assert public.maxedge_band(60) = 'PRIME', 'the line is 60';
  assert public.maxedge_band(59) = 'WATCH', 'and 59 is below it';
  assert public.maxedge_band(null) is null, 'no score is not a low score';

  -- the cap, and the least() trap it exists to avoid
  assert public.cap_at_watch('PRIME')  = 'WATCH',  'PRIME caps to WATCH';
  assert public.cap_at_watch('SLIGHT') = 'SLIGHT', 'nothing else moves';
  assert least('PRIME', 'WATCH') = 'PRIME',
    'sanity: least() really does return PRIME — this is why cap_at_watch exists';

  -- the rung: the runbook's four published cases
  assert public.signal_rung(2.00, 0.06, 60) = 'PRIME', 'in box, clears 60';
  assert public.signal_rung(2.00, 0.06, 59) = 'EDGE',  'in box, misses 60';
  assert public.signal_rung(2.00, 0.08, 99) = 'EDGE',  'EDGE box is never PRIME';
  assert public.signal_rung(2.00, 0.04, 99) = 'WATCH', 'out of box buys nothing';
  assert public.signal_rung(2.00, 0.06, null) is null, 'unscored is null, not NIL';
  assert public.signal_rung(3.50, 0.06, 99) = 'WATCH', 'the price leg bites too';

  -- mxs_band must NOT admit EDGE: it is a score band and EDGE is a box rung.
  assert not exists (
    select 1 from pg_constraint
     where conname = 'value_signals_mxs_band_check'
       and pg_get_constraintdef(oid) like '%EDGE%'),
    'mxs_band must not admit EDGE — it is a box rung, not a score band';
  assert (select count(*) from generate_series(0, 100) g
           where public.maxedge_band(g) = 'EDGE') = 0,
    'maxedge_band must never return EDGE';

  -- the widened constraints actually admit what the engine now writes
  assert (select count(*) from pg_constraint
           where conname = 'value_signals_mes_basis_check'
             and pg_get_constraintdef(oid) like '%yield_calibrated%') = 1,
    'mes_basis must admit yield_calibrated or every insert fails';
  assert (select count(*) from pg_constraint
           where conname = 'value_signals_signal_category_check'
             and pg_get_constraintdef(oid) like '%edge%') = 1,
    'signal_category must admit edge or every EDGE signal is rejected';

  -- MONOTONIC IN SCORE, and never promoted across the box. Walk every score at
  -- four price/edge points rather than trusting the four spot checks above.
  for i in 1..4 loop
    o := (array[2.00, 2.00, 2.00, 3.50])[i];
    e := (array[0.06, 0.08, 0.04, 0.06])[i];
    v_prev := -1;
    for m in 0..100 loop
      v_rung := public.signal_rung(o, e, m);
      v_rank := array_position(v_order, v_rung);
      assert v_rank >= v_prev,
        format('rung weakened as the score rose at %s/%s/%s', o, e, m);
      v_prev := v_rank;
      if not (o >= 1.40 and o < 3.00 and e >= 0.05 and e < 0.10) then
        assert v_rung not in ('PRIME','EDGE'),
          format('out-of-box row reached %s at score %s', v_rung, m);
      end if;
      if not (o >= 1.40 and o < 3.00 and e >= 0.05 and e < 0.07) then
        assert v_rung <> 'PRIME',
          format('only the PRIME box may be PRIME — %s/%s/%s', o, e, m);
      end if;
    end loop;
  end loop;

  raise notice '102: ladder installed — PRIME/EDGE/WATCH/SLIGHT/TRACE/NIL';
end $$;

commit;
