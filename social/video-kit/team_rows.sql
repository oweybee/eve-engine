with params as (select date '{{DATE}}' d),
fx as (
  select m.kickoff_at, m.home_team_id, m.away_team_id, th.name hn, ta.name an, l.name league, l.country
  from matches m join teams th on th.id=m.home_team_id join teams ta on ta.id=m.away_team_id left join leagues l on l.id=m.league_id, params
  where (m.kickoff_at at time zone 'Europe/London')::date = params.d
    and to_char(m.kickoff_at at time zone 'Europe/London','HH24:MI') >= '10:00'),
tm as (select home_team_id tid from fx union select away_team_id from fx),
dd as (
  select distinct on (home_team_id, away_team_id, (kickoff_at at time zone 'Europe/London')::date) *
  from matches where goals_home is not null and goals_away is not null
  order by home_team_id, away_team_id, (kickoff_at at time zone 'Europe/London')::date, (external_id ~ '^[0-9]+$') desc),
hist as (
  select t.tid, m.kickoff_at, (m.goals_home+m.goals_away) tg, (m.goals_home>0 and m.goals_away>0) btts,
         case when m.home_team_id=t.tid then 'H' else 'A' end ha,
         case when m.home_team_id=t.tid then oa.name else oh.name end opp,
         m.goals_home||'-'||m.goals_away sc,
         row_number() over (partition by t.tid order by m.kickoff_at desc) rn
  from tm t join dd m on (m.home_team_id=t.tid or m.away_team_id=t.tid)
  join teams oh on oh.id=m.home_team_id join teams oa on oa.id=m.away_team_id, params
  where m.kickoff_at < params.d),
seq as (
  select tid, count(*) n, max(kickoff_at)::date last_game,
    string_agg(case when tg>=3 then 'G' else 'R' end,'' order by kickoff_at) o3,
    string_agg(case when btts then 'G' else 'R' end,'' order by kickoff_at) bt,
    string_agg(case when tg<=2 then 'G' else 'R' end,'' order by kickoff_at) u2,
    string_agg(ha||'|'||replace(opp,'|','/')||'|'||sc||'|'||to_char(kickoff_at at time zone 'Europe/London','DD Mon'),';' order by kickoff_at desc) games
  from hist where rn<=10 group by tid),
j as (
  select to_char(fx.kickoff_at at time zone 'Europe/London','HH24:MI') ko, fx.hn, fx.an, fx.league, fx.country,
    (select lu.team_colors from lineups lu where lu.team_name=fx.hn and lu.team_colors ? 'primary' group by lu.team_colors order by count(*) desc limit 1) h_col,
    (select lu.team_colors from lineups lu where lu.team_name=fx.an and lu.team_colors ? 'primary' group by lu.team_colors order by count(*) desc limit 1) a_col,
    h.n hn_n, h.last_game h_last, h.o3 h_o3, h.bt h_bt, h.u2 h_u2, h.games h_games,
    a.n an_n, a.last_game a_last, a.o3 a_o3, a.bt a_bt, a.u2 a_u2, a.games a_games
  from fx join seq h on h.tid=fx.home_team_id join seq a on a.tid=fx.away_team_id, params
  where h.n>=8 and a.n>=8 and h.last_game > params.d - 35 and a.last_game > params.d - 35)
select json_agg(j order by ko) from j
where (length(replace(h_o3,'R',''))::float/hn_n>=0.7 and length(replace(a_o3,'R',''))::float/an_n>=0.7)
   or (length(replace(h_bt,'R',''))::float/hn_n>=0.7 and length(replace(a_bt,'R',''))::float/an_n>=0.7)
   or (length(replace(h_u2,'R',''))::float/hn_n>=0.7 and length(replace(a_u2,'R',''))::float/an_n>=0.7);
