-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805174458, name research_dc_predictions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

drop table if exists research_dc_preds cascade;

create table research_dc_preds as
with fk as (select * from (values
  (0,1.0::float8),(1,1.0),(2,2.0),(3,6.0),(4,24.0),(5,120.0),(6,720.0),
  (7,5040.0),(8,40320.0),(9,362880.0),(10,3628800.0),(11,39916800.0),(12,479001600.0)
) as t(k,kf)),
m as (
  select mr.id, mr.match_date, mr.div, mr.season, mr.fthg, mr.ftag, mr.ftr, mr.odds,
         th.tid as htid, ta.tid as atid,
         'dc_' || substring(mr.season, 1, 4) as fit_label
  from match_results mr
  join research_team_ids th on th.name = mr.home_team
  join research_team_ids ta on ta.name = mr.away_team
  where mr.season in ('2019/20','2020/21','2021/22','2022/23','2023/24','2024/25','2025/26')
    and mr.fthg is not null
),
lam as (
  select m.*, g.home_adv,
         greatest(0.05, ph.attack * pa.defence * g.home_adv)::float8 as lh,
         greatest(0.05, pa.attack * ph.defence)::float8              as la
  from m
  join research_dc_global g  on g.fit_label = m.fit_label
  join research_dc_params ph on ph.fit_label = m.fit_label and ph.tid = m.htid
  join research_dc_params pa on pa.fit_label = m.fit_label and pa.tid = m.atid
),
pk as (
  select l.id, fk.k,
         exp(-l.lh)*power(l.lh, fk.k)/fk.kf as ph,
         exp(-l.la)*power(l.la, fk.k)/fk.kf as pa
  from lam l cross join fk
),
cum as (select id, k, ph, pa, sum(ph) over (partition by id order by k) as cdf_h from pk),
agg as (
  select id,
    sum(pa*(1-cdf_h)) as hr, sum(pa*ph) as dr,
    max(ph) filter (where k=0) ph0, max(ph) filter (where k=1) ph1, max(ph) filter (where k=2) ph2,
    max(pa) filter (where k=0) pa0, max(pa) filter (where k=1) pa1, max(pa) filter (where k=2) pa2
  from cum group by id
)
select l.id, l.match_date, l.div, l.season, l.fthg, l.ftag, l.ftr, l.odds,
       l.lh, l.la, l.fit_label,
       a.hr/(a.hr+a.dr+greatest(1e-9,1-a.hr-a.dr)) as p_home,
       a.dr/(a.hr+a.dr+greatest(1e-9,1-a.hr-a.dr)) as p_draw,
       greatest(1e-9,1-a.hr-a.dr)/(a.hr+a.dr+greatest(1e-9,1-a.hr-a.dr)) as p_away,
       (1-a.ph0)*(1-a.pa0) as p_btts,
       (a.ph0*a.pa0 + a.ph0*a.pa1 + a.ph1*a.pa0 + a.ph0*a.pa2 + a.ph2*a.pa0 + a.ph1*a.pa1) as p_under25
from lam l join agg a on a.id = l.id;

create index if not exists dcp_idx on research_dc_preds (season, div);
