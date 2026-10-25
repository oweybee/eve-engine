-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805174654, name research_corners_cards. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Long format for corners and cards, so rolling form uses only prior matches.
drop table if exists research_disc_tm cascade;
create table research_disc_tm as
select mr.id as match_id, mr.match_date, th.tid, 'H' as venue,
       mr.hc as corners_for, mr.ac as corners_against,
       (mr.hy + coalesce(mr.hr,0)) as cards_own,
       (mr.hy + mr.ay + coalesce(mr.hr,0) + coalesce(mr.ar,0)) as cards_match,
       (mr.hc + mr.ac) as corners_match
from match_results mr join research_team_ids th on th.name = mr.home_team
where mr.hc is not null and mr.hy is not null
union all
select mr.id, mr.match_date, ta.tid, 'A',
       mr.ac, mr.hc,
       (mr.ay + coalesce(mr.ar,0)),
       (mr.hy + mr.ay + coalesce(mr.hr,0) + coalesce(mr.ar,0)),
       (mr.hc + mr.ac)
from match_results mr join research_team_ids ta on ta.name = mr.away_team
where mr.ac is not null and mr.ay is not null;

create index if not exists rdtm_idx on research_disc_tm (tid, venue, match_date, match_id);
