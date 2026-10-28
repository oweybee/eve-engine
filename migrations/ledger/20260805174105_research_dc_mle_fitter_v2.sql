-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805174105, name research_dc_mle_fitter_v2. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace function research_fit_dc(
  p_label   text,
  p_cutoff  date,
  p_xi      numeric default 0.0035,
  p_years   int default 5,
  p_maxiter int default 300,
  p_tol     float8 default 1e-10
) returns text
language plpgsql as $$
declare
  n_teams int;
  A float8[]; D float8[]; H float8 := 1.35;
  num_a float8[]; den_a float8[]; num_d float8[]; den_d float8[];
  active boolean[];
  mh int[]; ma int[]; mhg float8[]; mag float8[]; mw float8[];
  n_m int; k int; iter int := 0; n_active int := 0;
  h_num float8; h_den float8;
  delta float8; gm float8; sll float8;
  i int; hh int; aa int;
  ll float8 := 0; lam_h float8; lam_a float8;
  prev_ll float8 := -1e30;
begin
  select count(*) into n_teams from research_team_ids;

  select array_agg(htid order by ord), array_agg(atid order by ord),
         array_agg(hg order by ord),  array_agg(ag order by ord),
         array_agg(w order by ord),   count(*)
    into mh, ma, mhg, mag, mw, n_m
  from (
    select th.tid as htid, ta.tid as atid,
           mr.fthg::float8 as hg, mr.ftag::float8 as ag,
           exp(-p_xi::float8 * (p_cutoff - mr.match_date)::float8) as w,
           row_number() over (order by mr.match_date, mr.id) as ord
    from match_results mr
    join research_team_ids th on th.name = mr.home_team
    join research_team_ids ta on ta.name = mr.away_team
    where mr.fthg is not null and mr.ftag is not null
      and mr.match_date < p_cutoff
      and mr.match_date >= p_cutoff - (p_years * 365)
  ) s;

  if n_m is null or n_m < 100 then
    return format('too few training matches (%s)', coalesce(n_m,0));
  end if;

  A := array_fill(1.0::float8, array[n_teams]);
  D := array_fill(1.0::float8, array[n_teams]);
  active := array_fill(false, array[n_teams]);
  for k in 1..n_m loop
    active[mh[k]] := true; active[ma[k]] := true;
  end loop;
  for i in 1..n_teams loop
    if active[i] then n_active := n_active + 1; end if;
  end loop;

  for iter in 1..p_maxiter loop

    -- ---- pass 1: attack, using current D and H --------------------------
    num_a := array_fill(0.0::float8, array[n_teams]);
    den_a := array_fill(0.0::float8, array[n_teams]);
    for k in 1..n_m loop
      hh := mh[k]; aa := ma[k];
      num_a[hh] := num_a[hh] + mw[k] * mhg[k];
      num_a[aa] := num_a[aa] + mw[k] * mag[k];
      den_a[hh] := den_a[hh] + mw[k] * D[aa] * H;
      den_a[aa] := den_a[aa] + mw[k] * D[hh];
    end loop;
    for i in 1..n_teams loop
      if active[i] and den_a[i] > 1e-10 then
        A[i] := least(20.0, greatest(0.05, num_a[i] / den_a[i]));
      end if;
    end loop;

    -- ---- pass 2: defence, using the NEW A -------------------------------
    num_d := array_fill(0.0::float8, array[n_teams]);
    den_d := array_fill(0.0::float8, array[n_teams]);
    for k in 1..n_m loop
      hh := mh[k]; aa := ma[k];
      num_d[hh] := num_d[hh] + mw[k] * mag[k];
      num_d[aa] := num_d[aa] + mw[k] * mhg[k];
      den_d[hh] := den_d[hh] + mw[k] * A[aa];
      den_d[aa] := den_d[aa] + mw[k] * A[hh] * H;
    end loop;
    for i in 1..n_teams loop
      if active[i] and den_d[i] > 1e-10 then
        D[i] := least(20.0, greatest(0.05, num_d[i] / den_d[i]));
      end if;
    end loop;

    -- ---- pass 3: home advantage, using the NEW A and D ------------------
    h_num := 0; h_den := 0;
    for k in 1..n_m loop
      h_num := h_num + mw[k] * mhg[k];
      h_den := h_den + mw[k] * A[mh[k]] * D[ma[k]];
    end loop;
    if h_den > 1e-10 then H := least(5.0, greatest(0.2, h_num / h_den)); end if;

    -- ---- identifiability over ACTIVE teams only -------------------------
    gm := 0; k := 0;
    for i in 1..n_teams loop
      if active[i] and A[i] > 1e-9 then gm := gm + ln(A[i]); k := k + 1; end if;
    end loop;
    if k > 0 then
      gm := exp(gm / k);
      for i in 1..n_teams loop
        if active[i] then A[i] := A[i] / gm; D[i] := D[i] * gm; end if;
      end loop;
    end if;

    -- ---- convergence on the weighted log-likelihood ---------------------
    sll := 0;
    for k in 1..n_m loop
      lam_h := greatest(1e-9, A[mh[k]] * D[ma[k]] * H);
      lam_a := greatest(1e-9, A[ma[k]] * D[mh[k]]);
      sll := sll + mw[k] * ( -lam_h + mhg[k]*ln(lam_h) - lam_a + mag[k]*ln(lam_a) );
    end loop;
    delta := abs(sll - prev_ll);
    prev_ll := sll;
    exit when delta < p_tol and iter > 5;
  end loop;

  ll := prev_ll;

  delete from research_dc_params where fit_label = p_label;
  insert into research_dc_params (fit_label, tid, attack, defence, weight_sum)
  select p_label, g.i, A[g.i], D[g.i], case when active[g.i] then 1 else 0 end
  from generate_series(1, n_teams) g(i)
  where active[g.i];

  delete from research_dc_global where fit_label = p_label;
  insert into research_dc_global
    (fit_label, home_adv, xi, train_from, train_to, train_n, iterations, converged, loglik)
  values (p_label, H, p_xi, p_cutoff - (p_years*365), p_cutoff, n_m, iter, delta < p_tol, ll);

  return format('%s: n=%s teams=%s iters=%s home_adv=%s loglik=%s',
                p_label, n_m, n_active, iter, round(H::numeric,4), round(ll::numeric,1));
end;
$$;
