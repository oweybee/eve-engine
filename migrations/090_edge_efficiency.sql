-- ════════════════════════════════════════════════════════════════════════════
-- 090 — the Edge Efficiency Factor, f(edge)
--
-- Owner ruling, 21 Aug 2026. The stored `mxs` becomes the EDGE-ADJUSTED score:
--
--     mxs = round( maxedge_score(gap, sigma, z_gate) * edge_efficiency(edge) )
--
-- WHY. `maxedge_score` answers one question — how many of an architecture's own
-- error bars separate our number from the de-vigged market — and it is a good
-- question that cannot see a stale line. The settled book can. Odds 1.40-3.00,
-- clustered by fixture:
--
--     edge  4-10%    141 bets   +15.86%   z +1.64
--     edge 10-20%     75 bets   -12.81%   z -0.96
--     edge   20%+      3 bets    -6.67%
--
-- Before this, that was expressed as a badge DEMOTION on top of an undisturbed
-- score: the board drew `MES 80` and `WATCH` on one row and a reader had to
-- reconcile them. The decay puts it in the number.
--
-- WHAT IT COSTS, AND THIS MIGRATION IS THE RECORD OF IT. `maxedge_score` is
-- 100*(1 - 0.35^z) and every cutoff in `maxedge_band` is that inverted at a
-- round multiple of sigma. A MULTIPLIED SCORE IS NO LONGER THAT EXPRESSION, so
-- a stored 52 no longer inverts to a count of error bars. `mxs_raw` is stored
-- beside it so the sigma reading survives; `mes_basis` says which definition a
-- row was written under.
--
-- **NO HISTORY IS REWRITTEN.** Every existing `mxs` was computed on the raw
-- basis and stays exactly as it is, stamped `mes_basis = 'raw_sigma'`. This is
-- the rule migration 058 set for `gap_basis` and it is the same rule: NEVER
-- average `mxs` across rows written on different bases — filter or group by
-- `mes_basis`. A backfill is impossible anyway, because `detected_edge` at the
-- moment of scoring is the input and re-deriving it from a stored row would
-- reproduce the number, not the market it was taken from.
--
-- `maxedge_band` is UNTOUCHED. The cutoffs did not move; what moved is the
-- number handed to them.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── f(edge) ─────────────────────────────────────────────────────────────────
--
--     edge <= 0%      0.50           nothing to be efficient about
--     0 -> 4%         0.50 -> 1.00   linear; a thin edge is mostly noise
--     4% -> 9%        1.00           the plateau the settled book supports
--     9% -> 10%       1.00 -> 0.65   the knee
--     10% -> 12%      0.65 -> 0.40   the stale-line shoulder
--     edge > 12%      0.25           trap zone, hard floor
--
-- THE KNEE IS 0.65 FOR A REASON THAT IS ARITHMETIC, NOT TASTE. `maxedge_score`
-- caps the raw score at 99 and the PRIME line is 65; 99 * 0.65 = 64.35, which
-- rounds to 64. So "no signal above a 10% edge can be PRIME" is a THEOREM here
-- rather than an observation about today's rows. Move the knee or the cap and
-- the guarantee goes with it — the assertion block at the end of this file
-- fails if either does.
--
-- Continuous at 4%, 9% and 10%. The step at 12% (0.40 -> 0.25) is the one
-- deliberate cliff: past it we are not scoring a disagreement, we are declining
-- to believe a price.
create or replace function public.edge_efficiency(p_edge numeric)
returns numeric
language sql
immutable
parallel safe
set search_path to 'public', 'pg_catalog'
as $$
  select case
    when p_edge is null   then 1.0
    when p_edge <= 0      then 0.50
    when p_edge <  0.04   then 0.50 + (p_edge / 0.04) * 0.50
    when p_edge <= 0.09   then 1.00
    when p_edge <= 0.10   then 1.00 - ((p_edge - 0.09) / 0.01) * 0.35
    when p_edge <= 0.12   then 0.65 - ((p_edge - 0.10) / 0.02) * 0.25
    else                       0.25
  end::numeric;
$$;

comment on function public.edge_efficiency(numeric) is
  'Edge Efficiency Factor f(edge). Mirrors edgeEfficiency() in '
  'eve-engine/lib/maxedge.js and eve-frontend/lib/maxedge.ts — all three must '
  'agree, because a score the engine stores and a score the browser derives '
  'for one row have to be the same number.';

-- ── the final score ─────────────────────────────────────────────────────────
-- A separate function rather than a redefinition of `maxedge_score`, because
-- the raw score is still a real quantity that other things read and its name
-- means the sigma formula. Two names, two meanings, no ambiguity about which
-- one a caller wanted.
create or replace function public.maxedge_score_final(
  p_gap numeric, p_sigma numeric, p_edge numeric, p_z_gate numeric default 1.0
) returns integer
language sql
immutable
parallel safe
set search_path to 'public', 'pg_catalog'
as $$
  select case
    when public.maxedge_score(p_gap, p_sigma, p_z_gate) is null then null
    else round(public.maxedge_score(p_gap, p_sigma, p_z_gate)
               * public.edge_efficiency(p_edge))::int
  end;
$$;

-- ── the columns ─────────────────────────────────────────────────────────────
alter table public.value_signals
  add column if not exists mxs_raw        integer,
  add column if not exists mes_efficiency numeric(5,4),
  add column if not exists mes_basis      text;

comment on column public.value_signals.mxs_raw is
  '100*(1 - 0.35^z) before f(edge) — the number that still inverts to a count '
  'of error bars. mxs no longer does.';
comment on column public.value_signals.mes_basis is
  'Which definition of mxs this row was written under. NEVER average or '
  'compare mxs across bases — same rule as gap_basis (migration 058).';

-- Every row that exists was written on the raw basis, and its mxs IS its raw
-- score. Stamped rather than recomputed.
update public.value_signals
   set mes_basis      = 'raw_sigma',
       mxs_raw        = coalesce(mxs_raw, mxs),
       mes_efficiency = coalesce(mes_efficiency, 1.0)
 where mes_basis is null;

alter table public.value_signals
  drop constraint if exists value_signals_mes_basis_check;
alter table public.value_signals
  add constraint value_signals_mes_basis_check
  check (mes_basis is null or mes_basis in ('raw_sigma', 'edge_adjusted'));

-- ── assertions, before this commits ─────────────────────────────────────────
do $$
declare
  v numeric;
  n bigint;
begin
  -- The three cases the brief states, through the shipped function.
  v := public.edge_efficiency(0.075);
  if v <> 1.00 then raise exception 'f(7.5%%) = % , expected 1.00', v; end if;

  v := public.edge_efficiency(0.101);
  if round(v, 4) <> 0.6375 then raise exception 'f(10.1%%) = %, expected 0.6375', v; end if;
  if round(80 * v) <> 51 then raise exception 'raw 80 at 10.1%% -> %, expected 51', round(80*v); end if;

  v := public.edge_efficiency(0.158);
  if v <> 0.25 then raise exception 'f(15.8%%) = %, expected 0.25', v; end if;
  if round(80 * v) <> 20 then raise exception 'raw 80 at 15.8%% -> %, expected 20', round(80*v); end if;

  -- THE GUARANTEE: nothing above a 10% edge can reach the PRIME line, for ANY
  -- raw score the scorer can produce. Walked, not reasoned about.
  select count(*) into n
    from generate_series(1001, 3000) e(bp)          -- 10.01% .. 30.00%
   cross join generate_series(0, 99) r(raw)
   where round(r.raw * public.edge_efficiency(e.bp / 10000.0)) >= 65;
  if n <> 0 then
    raise exception 'edge > 10%% still reaches PRIME in % (raw, edge) pairs', n;
  end if;

  -- Continuity at the three knees that are meant to be continuous.
  if abs(public.edge_efficiency(0.0399999) - public.edge_efficiency(0.04)) > 0.001
     or abs(public.edge_efficiency(0.0899999) - public.edge_efficiency(0.09)) > 0.001
     or abs(public.edge_efficiency(0.0999999) - public.edge_efficiency(0.10)) > 0.001 then
    raise exception 'f(edge) is discontinuous at a knee that must be smooth';
  end if;

  -- The cliff at 12% is deliberate and must still be there.
  if public.edge_efficiency(0.12) - public.edge_efficiency(0.1201) < 0.10 then
    raise exception 'the trap-zone cliff at 12%% has gone';
  end if;

  -- History is untouched and stamped.
  select count(*) into n from public.value_signals where mes_basis is null;
  if n <> 0 then raise exception '% rows left with no mes_basis', n; end if;

  select count(*) into n from public.value_signals
   where mes_basis = 'raw_sigma' and mxs is not null and mxs_raw is distinct from mxs;
  if n <> 0 then raise exception '% legacy rows had mxs rewritten', n; end if;

  -- maxedge_band did NOT move. The cutoffs are the same four numbers.
  if public.maxedge_band(65) <> 'PRIME' or public.maxedge_band(64) <> 'WATCH'
     or public.maxedge_band(41) <> 'WATCH' or public.maxedge_band(40) <> 'SLIGHT'
     or public.maxedge_band(23) <> 'SLIGHT' or public.maxedge_band(22) <> 'TRACE'
     or public.maxedge_band(10) <> 'TRACE'  or public.maxedge_band(9)  <> 'NIL' then
    raise exception 'maxedge_band cutoffs moved — they must not';
  end if;

  raise notice '090 ok: f(edge) live, % rows stamped raw_sigma, no history rewritten',
    (select count(*) from public.value_signals where mes_basis = 'raw_sigma');
end $$;

commit;

-- Reversal: the score columns are additive and the functions are new, so
--   alter table public.value_signals drop column mxs_raw, drop column
--     mes_efficiency, drop column mes_basis;
--   drop function public.maxedge_score_final(numeric, numeric, numeric, numeric);
--   drop function public.edge_efficiency(numeric);
-- puts the database back. The engine must be rolled back with it, or it writes
-- an edge-adjusted mxs into a schema that no longer says so.
