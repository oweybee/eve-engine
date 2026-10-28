-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805174014, name research_dc_mle_fitter. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Proper Dixon-Coles: attack and defence strengths fitted jointly by weighted
-- maximum likelihood, so lambda_home and lambda_away come from ONE model.
-- This replaces the hybrid (pi-ratings for the difference, rolling shots for the
-- sum) whose totals component had a Platt slope of 0.099.
--
-- Fitted by iterative scaling on the weighted Poisson likelihood:
--   lambda_home = A_i * D_j * H
--   lambda_away = A_j * D_i
-- Stationary point: for each team, weighted goals scored = weighted fitted goals.

create table if not exists research_dc_params (
  fit_label  text    not null,
  tid        int     not null,
  attack     float8  not null,
  defence    float8  not null,
  weight_sum float8,
  primary key (fit_label, tid)
);

create table if not exists research_dc_global (
  fit_label   text primary key,
  home_adv    float8,
  xi          numeric,
  train_from  date,
  train_to    date,
  train_n     int,
  iterations  int,
  converged   boolean,
  loglik      float8
);

create or replace function research_fit_dc(
  p_label   text,
  p_cutoff  date,             -- fit on matches strictly BEFORE this date
  p_xi      numeric default 0.0035,  -- decay per day (0.0035 ~ 200-day half-life)
  p_years   int default 5,
  p_maxiter int default 200,
  p_tol     float8 default 1e-9
) returns text
language plpgsql as $$
declare
  n_teams int;
  A float8[]; D float8[]; H float8 := 1.35;
  num_a float8[]; den_a float8[]; num_d float8[]; den_d float8[];
  mh float8[]; ma float8[]; mhg float8[]; mag float8[]; mw float8[];
  n_m int; k int; it int;
  h_num float8; h_den float8;
  delta float8; prev float8; gm float8;
  i int; hh int; aa int;
  ll float8 := 0; lam_h float8; lam_a float8;
begin
  select count(*) into n_teams from research_team_ids;

  -- load the training window into arrays once
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

  for it in 1..p_maxiter loop
    prev := H;
    num_a := array_fill(0.0::float8, array[n_teams]);
    den_a := array_fill(0.0::float8, array[n_teams]);
    num_d := array_fill(0.0::float8, array[n_teams]);
    den_d := array_fill(0.0::float8, array[n_teams]);
    h_num := 0; h_den := 0;

    for k in 1..n_m loop
      hh := mh[k]; aa := ma[k];
      -- attack numerators: goals scored
      num_a[hh] := num_a[hh] + mw[k] * mhg[k];
      num_a[aa] := num_a[aa] + mw[k] * mag[k];
      -- attack denominators: opponent defence x venue
      den_a[hh] := den_a[hh] + mw[k] * D[aa] * H;
      den_a[aa] := den_a[aa] + mw[k] * D[hh];
      -- defence numerators: goals conceded
      num_d[hh] := num_d[hh] + mw[k] * mag[k];
      num_d[aa] := num_d[aa] + mw[k] * mhg[k];
      -- defence denominators
      den_d[hh] := den_d[hh] + mw[k] * A[aa];
      den_d[aa] := den_d[aa] + mw[k] * A[hh] * H;
      -- home advantage
      h_num := h_num + mw[k] * mhg[k];
      h_den := h_den + mw[k] * A[hh] * D[aa];
    end loop;

    for i in 1..n_teams loop
      if den_a[i] > 1e-12 then A[i] := num_a[i] / den_a[i]; end if;
      if den_d[i] > 1e-12 then D[i] := num_d[i] / den_d[i]; end if;
    end loop;
    if h_den > 1e-12 then H := h_num / h_den; end if;

    -- identifiability: hold the geometric mean of attack at 1
    gm := 0; k := 0;
    for i in 1..n_teams loop
      if A[i] > 1e-9 then gm := gm + ln(A[i]); k := k + 1; end if;
    end loop;
    if k > 0 then
      gm := exp(gm / k);
      for i in 1..n_teams loop
        A[i] := A[i] / gm;
        D[i] := D[i] * gm;
      end loop;
    end if;

    delta := abs(H - prev);
    exit when delta < p_tol and it > 5;
  end loop;

  -- weighted log-likelihood at the fit
  for k in 1..n_m loop
    lam_h := greatest(1e-9, A[mh[k]] * D[ma[k]] * H);
    lam_a := greatest(1e-9, A[ma[k]] * D[mh[k]]);
    ll := ll + mw[k] * ( -lam_h + mhg[k]*ln(lam_h) - lam_a + mag[k]*ln(lam_a) );
  end loop;

  delete from research_dc_params where fit_label = p_label;
  insert into research_dc_params (fit_label, tid, attack, defence)
  select p_label, g.i, A[g.i], D[g.i] from generate_series(1, n_teams) g(i);

  delete from research_dc_global where fit_label = p_label;
  insert into research_dc_global
    (fit_label, home_adv, xi, train_from, train_to, train_n, iterations, converged, loglik)
  values (p_label, H, p_xi, p_cutoff - (p_years*365), p_cutoff, n_m, it, delta < p_tol, ll);

  return format('%s: n=%s iters=%s home_adv=%s loglik=%s',
                p_label, n_m, it, round(H::numeric,4), round(ll::numeric,1));
end;
$$;
