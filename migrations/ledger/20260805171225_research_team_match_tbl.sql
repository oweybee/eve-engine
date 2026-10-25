-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805171225, name research_team_match_tbl. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

drop table if exists research_team_match cascade;
create table research_team_match as
select mr.id as match_id, mr.match_date, th.tid, 'H'::text as venue,
       mr.hst as sf, mr.ast as sa
from match_results mr join research_team_ids th on th.name = mr.home_team
where mr.hst is not null
union all
select mr.id, mr.match_date, ta.tid, 'A', mr.ast, mr.hst
from match_results mr join research_team_ids ta on ta.name = mr.away_team
where mr.ast is not null;
