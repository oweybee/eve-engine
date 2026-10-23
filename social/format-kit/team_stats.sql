-- Last 10 completed games for each named club, one row per match date (the matches table can hold
-- duplicate rows for one game, so this takes one per club per day). Replace {{TEAMS}} with
-- a comma-separated list of quoted teams.name values, e.g. 'Bournemouth','AC Milan'.
-- Run with Supabase execute_sql (project zlbmpeiuhyllxwegtayu), save the json_agg array as rows.json,
-- then: python3 make_stats.py rows.json S.json
with t as (select id, name from teams where name in ({{TEAMS}})),
g as (
  select distinct on (t.name, m.kickoff_at::date) t.name team, m.kickoff_at::date d,
    case when m.home_team_id = t.id then 'H' else 'A' end ha,
    case when m.home_team_id = t.id then a.name else h.name end opp,
    case when m.home_team_id = t.id then m.goals_home else m.goals_away end gf,
    case when m.home_team_id = t.id then m.goals_away else m.goals_home end ga
  from t join matches m on (m.home_team_id = t.id or m.away_team_id = t.id)
  join teams h on h.id = m.home_team_id join teams a on a.id = m.away_team_id
  where m.status = 'completed' and m.goals_home is not null and m.kickoff_at < now()
  order by t.name, m.kickoff_at::date desc),
r as (select *, row_number() over (partition by team order by d desc) rn from g)
select json_agg(json_build_object('team', team, 'd', to_char(d, 'DD Mon'), 'ha', ha, 'opp', opp, 'gf', gf, 'ga', ga) order by team, d desc)
from r where rn <= 10;
