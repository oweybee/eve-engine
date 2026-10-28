-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805170819, name research_pi_ratings_fix_log. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace function research_build_pi_ratings(
  p_lambda numeric default 0.035,
  p_gamma  numeric default 0.700
) returns text
language plpgsql as $$
declare
  n_teams int;
  gh float8[]; ga float8[]; sh float8[]; sa float8[];
  played int[];
  rec record;
  lam float8 := p_lambda::float8;
  gam float8 := p_gamma::float8;
  conv float8;
  ln10 float8 := ln(10.0);
  exp_gd float8; obs_gd float8; err float8; psi float8; dir float8;
  d_home float8; d_away float8; s_exp float8; s_obs float8;
  n_done int := 0;
begin
  select count(*) into n_teams from research_team_ids;
  gh := array_fill(0.0::float8, array[n_teams]);
  ga := array_fill(0.0::float8, array[n_teams]);
  sh := array_fill(0.0::float8, array[n_teams]);
  sa := array_fill(0.0::float8, array[n_teams]);
  played := array_fill(0, array[n_teams]);

  select sum(fthg + ftag)::float8 / nullif(sum(hst + ast), 0)::float8
    into conv
  from match_results where hst is not null and ast is not null;

  truncate research_match_ratings;

  for rec in
    select mr.id, mr.match_date, mr.div, mr.season,
           th.tid as htid, ta.tid as atid, mr.fthg, mr.ftag, mr.hst, mr.ast
    from match_results mr
    join research_team_ids th on th.name = mr.home_team
    join research_team_ids ta on ta.name = mr.away_team
    where mr.fthg is not null and mr.ftag is not null
    order by mr.match_date, mr.id
  loop
    exp_gd := sign(gh[rec.htid]) * (power(10.0, abs(gh[rec.htid]) / 3.0) - 1.0)
            - sign(ga[rec.atid]) * (power(10.0, abs(ga[rec.atid]) / 3.0) - 1.0);
    s_exp  := sign(sh[rec.htid]) * (power(10.0, abs(sh[rec.htid]) / 3.0) - 1.0)
            - sign(sa[rec.atid]) * (power(10.0, abs(sa[rec.atid]) / 3.0) - 1.0);

    insert into research_match_ratings
      (id, match_date, div, season, home_tid, away_tid,
       g_r_home, g_r_away, g_exp_gd, s_r_home, s_r_away, s_exp_gd,
       home_played, away_played)
    values
      (rec.id, rec.match_date, rec.div, rec.season, rec.htid, rec.atid,
       gh[rec.htid], ga[rec.atid], exp_gd, sh[rec.htid], sa[rec.atid], s_exp,
       played[rec.htid], played[rec.atid]);

    obs_gd := (rec.fthg - rec.ftag)::float8;
    err    := abs(obs_gd - exp_gd);
    psi    := 3.0 * ln(1.0 + err) / ln10;
    dir    := case when obs_gd > exp_gd then 1.0 else -1.0 end;
    d_home := psi * lam * dir;
    d_away := -psi * lam * dir;
    gh[rec.htid] := gh[rec.htid] + d_home;
    ga[rec.atid] := ga[rec.atid] + d_away;
    ga[rec.htid] := ga[rec.htid] + d_home * gam;
    gh[rec.atid] := gh[rec.atid] + d_away * gam;

    if rec.hst is not null and rec.ast is not null then
      s_obs  := (rec.hst - rec.ast)::float8 * conv;
      err    := abs(s_obs - s_exp);
      psi    := 3.0 * ln(1.0 + err) / ln10;
      dir    := case when s_obs > s_exp then 1.0 else -1.0 end;
      d_home := psi * lam * dir;
      d_away := -psi * lam * dir;
      sh[rec.htid] := sh[rec.htid] + d_home;
      sa[rec.atid] := sa[rec.atid] + d_away;
      sa[rec.htid] := sa[rec.htid] + d_home * gam;
      sh[rec.atid] := sh[rec.atid] + d_away * gam;
    end if;

    played[rec.htid] := played[rec.htid] + 1;
    played[rec.atid] := played[rec.atid] + 1;
    n_done := n_done + 1;
  end loop;

  return format('built %s rows; goals-per-SoT = %s', n_done, round(conv::numeric, 4));
end;
$$;
