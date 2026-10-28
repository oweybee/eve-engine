-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805171242, name research_rolling_tbl. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create index if not exists rtm_idx on research_team_match (tid, venue, match_date, match_id);

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

create index if not exists rr_idx on research_rolling (match_id, venue);
