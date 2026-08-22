-- 093 — f(edge): the low ramp starts its plateau at 3%, not 4%.
--
-- Owner ruling, 22 Aug 2026, the morning after 090 shipped f(edge).
--
-- WHY. The multiplier was commissioned against STALE HIGH edges — the 10%+
-- trap zone, where the settled book returns -12.81% over 75 bets. But the
-- curve penalises the quiet end just as hard, and that is the end this board
-- actually lives at. Measured a few hours after 090 landed: of 41 open
-- published signals only FOUR scored 65 or above, and the rows that lost PRIME
-- to the multiplier lost it at edges of 2.47% and 3.32% — BELOW the old
-- plateau, nowhere near the knee the curve was built for.
--
--     Hibernian v Kilmarnock   h2h 1.71   edge 2.47%   66 -> 53   WATCH
--     Livingston v Dunfermline btts 1.87  edge 3.32%   71 -> 65   PRIME, exactly
--
-- A 3% plateau gives the 3-4% band its whole score back. It does NOT rescue
-- the 2.47% row (f = 0.912 there, 66 -> 60): the ramp still exists, it just
-- starts climbing sooner. Nothing was moved to make a particular row pass.
--
-- THE HIGH-SIDE GUARANTEE IS UNTOUCHED, and that is the point of changing only
-- this one number. The knee (0.09-0.10 -> 0.65), the shoulder (0.10-0.12 ->
-- 0.40) and the trap floor (0.25) are identical, so 65/0.65 = 100 against a
-- raw cap of 99 still makes "nothing over a 10% edge can be PRIME" a THEOREM.
-- The assertion at the foot of this file re-proves it rather than trusting the
-- sentence.
--
-- NO HISTORY IS REWRITTEN. `mes_basis` still says which definition a row was
-- written under, and both 'raw_sigma' and 'edge_adjusted' rows keep the score
-- they were stored with — the rule 058 set for `gap_basis`. Rows written
-- between 090 and this migration carry an edge_adjusted score computed on the
-- 4% ramp; they are not re-scored, because a settled record is a record. The
-- browser re-prices PENDING rows live, so those pick the new curve up on their
-- next paint.

begin;

create or replace function public.edge_efficiency(p_edge numeric)
returns numeric
language sql immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $function$
  select case
    when p_edge is null   then 1.0
    when p_edge <= 0      then 0.50
    when p_edge <  0.03   then 0.50 + (p_edge / 0.03) * 0.50
    when p_edge <= 0.09   then 1.00
    when p_edge <= 0.10   then 1.00 - ((p_edge - 0.09) / 0.01) * 0.35
    when p_edge <= 0.12   then 0.65 - ((p_edge - 0.10) / 0.02) * 0.25
    else                       0.25
  end::numeric;
$function$;

do $$
declare bad int;
begin
  -- The shape, at every knee.
  if public.edge_efficiency(0.015)::numeric(10,4) <> 0.7500 then
    raise exception '093: halfway up the ramp should be 0.75, got %', public.edge_efficiency(0.015);
  end if;
  if public.edge_efficiency(0.03) <> 1.00 or public.edge_efficiency(0.0332) <> 1.00 then
    raise exception '093: the 3-4%% band must keep its whole score';
  end if;
  if public.edge_efficiency(0.0247)::numeric(10,4) <> 0.9117 then
    raise exception '093: the ramp below 3%% must still exist, got %', public.edge_efficiency(0.0247);
  end if;

  -- The high side, unmoved. These are what the theorem rests on.
  if public.edge_efficiency(0.10)::numeric(10,4) <> 0.6500 then
    raise exception '093: the knee moved — the >10%% guarantee is gone';
  end if;
  if public.edge_efficiency(0.1201) <> 0.25 then
    raise exception '093: the trap floor moved';
  end if;

  -- And the guarantee itself, walked rather than reasoned about: no raw score
  -- the engine can produce (capped at 99) may clear 65 above a 10% edge.
  select count(*) into bad
  from generate_series(1, 99) raw,
       generate_series(1001, 3000) bp
  where round(raw * public.edge_efficiency(bp / 10000.0)) >= 65;
  if bad > 0 then
    raise exception '093: % (raw, edge) pair(s) above 10%% still reach PRIME', bad;
  end if;
end $$;

commit;
