-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805171110, name research_rolling_form. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

drop table if exists research_team_match cascade;
create table research_team_match as
select mr.id as match_id, mr.match_date, th.tid,
       'H'::text as venue, mr.hst as sf, mr.ast as sa
from match_results mr join research_team_ids th on th.name = mr.home_team
union all
select mr.id, mr.match_date, ta.tid,
       'A', mr.ast, mr.hst
from match_results mr join research_team_ids ta on ta.name = mr.away_team;

create index on research_team_match (tid, venue, match_date, match_id);

drop table if exists research_rolling cascade;
create table research_rolling as
select match_id, tid, venue,
  avg(sf) over w as roll_sot_for,
  avg(sa) over w as roll_sot_against,
  count(sf) over w as roll_n
from research_team_match
window w as (
  partition by tid, venue order by match_date, match_id
  rows between 6 preceding and 1 preceding
);

create index on research_rolling (match_id, venue);
