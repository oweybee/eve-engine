-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805173134, name research_model_probs_v2. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

drop table if exists research_model_probs cascade;

create table research_model_probs as
with fk as (select * from (values
  (0,1.0::float8),(1,1.0),(2,2.0),(3,6.0),(4,24.0),(5,120.0),(6,720.0),
  (7,5040.0),(8,40320.0),(9,362880.0),(10,3628800.0),(11,39916800.0),(12,479001600.0)
) as t(k,kf)),
lam as (
  select r.id, r.match_date, r.div, r.season, r.g_exp_gd,
         m.fthg, m.ftag, m.ftr, m.odds,
         r.home_played, r.away_played,
         least(rh.roll_n, ra.roll_n) as roll_n,
         greatest(0.15,
           ((coalesce(rh.roll_sot_for,4.5) + coalesce(ra.roll_sot_against,4.5)) / 2.0
          + (coalesce(ra.roll_sot_for,4.0) + coalesce(rh.roll_sot_against,4.0)) / 2.0)
           * 0.2694 / 2.0 + r.g_exp_gd / 2.0)::float8 as lh,
         greatest(0.15,
           ((coalesce(rh.roll_sot_for,4.5) + coalesce(ra.roll_sot_against,4.5)) / 2.0
          + (coalesce(ra.roll_sot_for,4.0) + coalesce(rh.roll_sot_against,4.0)) / 2.0)
           * 0.2694 / 2.0 - r.g_exp_gd / 2.0)::float8 as la
  from research_match_ratings r
  join match_results m on m.id = r.id
  left join research_rolling rh on rh.match_id = r.id and rh.venue = 'H'
  left join research_rolling ra on ra.match_id = r.id and ra.venue = 'A'
  where r.home_played >= 50 and r.away_played >= 50
    and m.odds is not null
    and least(rh.roll_n, ra.roll_n) >= 20
),
pk as (
  select l.id, fk.k,
         exp(-l.lh) * power(l.lh, fk.k) / fk.kf as ph,
         exp(-l.la) * power(l.la, fk.k) / fk.kf as pa
  from lam l cross join fk
),
cum as (
  select id, k, ph, pa, sum(ph) over (partition by id order by k) as cdf_h from pk
),
agg as (
  select id,
    sum(pa * (1 - cdf_h)) as p_home_raw,
    sum(pa * ph)          as p_draw_raw,
    max(ph) filter (where k=0) as ph0, max(ph) filter (where k=1) as ph1,
    max(ph) filter (where k=2) as ph2,
    max(pa) filter (where k=0) as pa0, max(pa) filter (where k=1) as pa1,
    max(pa) filter (where k=2) as pa2
  from cum group by id
),
norm as (
  select l.*, a.ph0, a.pa0, a.ph1, a.pa1, a.ph2, a.pa2,
    a.p_home_raw as hr, a.p_draw_raw as dr,
    greatest(1e-9, 1 - a.p_home_raw - a.p_draw_raw) as ar
  from lam l join agg a on a.id = l.id
)
select id, match_date, div, season, fthg, ftag, ftr, odds,
       lh, la, g_exp_gd, home_played, away_played, roll_n,
       hr/(hr+dr+ar) as p_home,
       dr/(hr+dr+ar) as p_draw,
       ar/(hr+dr+ar) as p_away,
       (1-ph0)*(1-pa0) as p_btts,
       (ph0*pa0 + ph0*pa1 + ph1*pa0 + ph0*pa2 + ph2*pa0 + ph1*pa1) as p_under25
from norm;

create index if not exists rmp_date on research_model_probs (match_date);
