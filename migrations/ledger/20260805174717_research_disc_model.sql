-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805174717, name research_disc_model. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

drop table if exists research_disc_roll cascade;
create table research_disc_roll as
select match_id, tid, venue,
  avg(corners_for)     over w as r_cf,
  avg(corners_against) over w as r_ca,
  avg(cards_own)       over w as r_cards_own,
  avg(cards_match)     over w as r_cards_match,
  count(*)             over w as r_n
from research_disc_tm
window w as (partition by tid, venue order by match_date, match_id
             rows between 25 preceding and 1 preceding);
create index if not exists rdr_idx on research_disc_roll (match_id, venue);

-- Referee tendency from that referee's PRIOR matches only (expanding window).
drop table if exists research_ref_roll cascade;
create table research_ref_roll as
select id as match_id, referee,
  avg(hy + ay + coalesce(hr,0) + coalesce(ar,0)) over w as ref_cards_prior,
  count(*) over w as ref_n
from match_results
where referee is not null and hy is not null
window w as (partition by referee order by match_date, id
             rows between unbounded preceding and 1 preceding);
create index if not exists rrr_idx on research_ref_roll (match_id);
