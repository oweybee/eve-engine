-- 192: season market rankings, the data behind /rankings (6 Nov 2026).
--
-- Owner, 6 Nov: one rankings page covering as many markets as the data allows
-- (goals, BTTS, corners, cards, over and under), with filters. Brief:
-- claude/rankings-hub-brief-6-nov.md in the MaxEdge Project.
--
-- WHAT IT IS. For every club and every market, how often that market landed in
-- the club's LEAGUE games this season, beside the club's next fixture, the
-- opponent's record in the mirrored market and a "combined hit rate" for that
-- game. Settled history only: no price, no edge, no model, no fair line. It is
-- public for the same reason /leagues and v_match_extras are (settled history is
-- never gated; owner ruling 24 Oct on past corners and cards).
--
-- WHAT THE COMBINED FIGURE IS AND IS NOT. Each side's season rate is pulled
-- towards its league's average for the market, (hits + 5 x league) / (games + 5),
-- so a 12-from-12 run does not read as certain, and the two are averaged. It is a
-- blend of two records. It is NOT a probability and the page must never call it
-- a chance (public-copy-standard).
--
-- THREE OBJECTS:
--   ranking_markets          the market catalogue (code, stat, scope, label,
--                            mirror). The page builds its filters from it.
--   mx_team_market_rates     per club per market code: games counted, hits,
--                            average of the underlying quantity. Mirror codes
--                            (opponent conceded X+, teams facing them booked X+)
--                            live here too but are not listed.
--   mx_market_rankings       the ranked rows, next fixture and combined figure.
--   v_market_rankings        security_invoker view over it that drops a next
--                            fixture whose kickoff has passed since the last
--                            refresh. This is what the page reads.
--
-- DATA RULES (measured 6 Nov against production):
--   * League games only. A league is ranked iff leagues.season_anchor is set
--     (the month its season starts: 7 for Aug-May leagues, 1 for calendar-year
--     ones). Cups and international competitions stay null and are excluded.
--     The season start is derived at refresh time, so it rolls over each year
--     with nothing to edit.
--   * Corners and cards come from match_stats, the same source and the same
--     numeric guard as v_league_base_rates. A side's cards are yellows + reds,
--     each counted once, and are only known when its stats payload is populated
--     (corners present). Coverage: goals 100% of league games, corners and cards
--     about 79% (3,827 / 3,836 of 4,845); the gaps are whole leagues.
--   * A club ranks in a market only with at least 10 counted games AND at least
--     80% of its league games counted, so a missing match cannot flatter it, and
--     only if it has played in the last 14 days.
--   * Tie-break: exact hit rate, then games counted, then the market's own
--     average in the market's direction (goals a game for an over, fewer for an
--     under), then name.
--
-- REFRESH: pg_cron, hourly at :33, CONCURRENTLY (unique indexes below).
-- Reversible: drop the cron job, the view, both matviews, the table and the
-- leagues.season_anchor column.

set local lock_timeout = '5s';

-- 1. Which leagues are ranked, and when their season starts.
alter table public.leagues add column if not exists season_anchor smallint
  check (season_anchor between 1 and 12);
comment on column public.leagues.season_anchor is
  'Month a league season starts (7 = Aug-May, 1 = calendar year). Null = not ranked on /rankings (cups, international). Migration 192.';

update public.leagues set season_anchor = 1
 where (name, country) in (('Serie A','Brazil'),('Brazil Serie B','Brazil'),('Super League','China'),
   ('Veikkausliiga','Finland'),('Premier Division','Ireland'),('J1 League','Japan'),
   ('Eliteserien','Norway'),('Allsvenskan','Sweden'),('Major League Soccer','USA'));
update public.leagues set season_anchor = 7
 where season_anchor is null
   and country not in ('Africa','Europe','International','South America','World')
   and name not ilike '%cup%';

create or replace function public.league_season_start(anchor smallint, at_ts timestamptz default now())
returns date language sql immutable parallel safe as $$
  select case when anchor is null then null else
    make_date(extract(year from at_ts)::int - case when extract(month from at_ts) < anchor then 1 else 0 end, anchor, 1) end
$$;

-- 2. The market catalogue.
create table if not exists public.ranking_markets (
  code        text primary key,
  stat        text not null check (stat in ('goals','btts','corners','cards')),
  scope       text not null check (scope in ('match','team')),
  label       text not null,
  chip        text not null,
  mirror_code text not null,
  mirror_label text not null,
  direction   smallint not null check (direction in (-1, 1)),
  listed      boolean not null default true,
  sort_order  smallint not null
);
alter table public.ranking_markets enable row level security;
drop policy if exists public_read_ranking_markets on public.ranking_markets;
create policy public_read_ranking_markets on public.ranking_markets for select to anon, authenticated using (true);
revoke all on public.ranking_markets from anon, authenticated;
grant select on public.ranking_markets to anon, authenticated;

insert into public.ranking_markets (code, stat, scope, label, chip, mirror_code, mirror_label, direction, listed, sort_order) values
  ('o15','goals','match','Over 1.5 goals','Over 1.5','o15','Opponent',1,true,10),
  ('o25','goals','match','Over 2.5 goals','Over 2.5','o25','Opponent',1,true,11),
  ('o35','goals','match','Over 3.5 goals','Over 3.5','o35','Opponent',1,true,12),
  ('u15','goals','match','Under 1.5 goals','Under 1.5','u15','Opponent',-1,true,13),
  ('u25','goals','match','Under 2.5 goals','Under 2.5','u25','Opponent',-1,true,14),
  ('u35','goals','match','Under 3.5 goals','Under 3.5','u35','Opponent',-1,true,15),
  ('btts','btts','match','BTTS yes','BTTS yes','btts','Opponent',1,true,20),
  ('bttsn','btts','match','BTTS no','BTTS no','bttsn','Opponent',-1,true,21),
  ('cs','goals','team','Clean sheet','Clean sheet','fts','Opponent failed to score',-1,true,30),
  ('fts','goals','team','Failed to score','Failed to score','cs','Opponent kept a clean sheet',-1,true,31),
  ('tg15','goals','team','Team scores 2+','Scores 2+','tga15','Opponent conceded 2+',1,true,32),
  ('tga15','goals','team','Conceded 2+','Conceded 2+','tg15','Opponent scored 2+',1,false,33),
  ('c85','corners','match','Over 8.5 corners','Over 8.5','c85','Opponent',1,true,40),
  ('c95','corners','match','Over 9.5 corners','Over 9.5','c95','Opponent',1,true,41),
  ('c105','corners','match','Over 10.5 corners','Over 10.5','c105','Opponent',1,true,42),
  ('cu85','corners','match','Under 8.5 corners','Under 8.5','cu85','Opponent',-1,true,43),
  ('cu95','corners','match','Under 9.5 corners','Under 9.5','cu95','Opponent',-1,true,44),
  ('cu105','corners','match','Under 10.5 corners','Under 10.5','cu105','Opponent',-1,true,45),
  ('tc35','corners','team','Team over 3.5 corners','Team over 3.5','tca35','Opponent conceded 4+',1,true,50),
  ('tc45','corners','team','Team over 4.5 corners','Team over 4.5','tca45','Opponent conceded 5+',1,true,51),
  ('tc55','corners','team','Team over 5.5 corners','Team over 5.5','tca55','Opponent conceded 6+',1,true,52),
  ('tca35','corners','team','Conceded 4+ corners','Conceded 4+','tc35','Opponent won 4+',1,false,53),
  ('tca45','corners','team','Conceded 5+ corners','Conceded 5+','tc45','Opponent won 5+',1,false,54),
  ('tca55','corners','team','Conceded 6+ corners','Conceded 6+','tc55','Opponent won 6+',1,false,55),
  ('k35','cards','match','Over 3.5 cards','Over 3.5','k35','Opponent',1,true,60),
  ('k45','cards','match','Over 4.5 cards','Over 4.5','k45','Opponent',1,true,61),
  ('k55','cards','match','Over 5.5 cards','Over 5.5','k55','Opponent',1,true,62),
  ('ku35','cards','match','Under 3.5 cards','Under 3.5','ku35','Opponent',-1,true,63),
  ('ku45','cards','match','Under 4.5 cards','Under 4.5','ku45','Opponent',-1,true,64),
  ('tk15','cards','team','Team over 1.5 cards','Team over 1.5','tka15','Teams facing them booked 2+',1,true,70),
  ('tk25','cards','team','Team over 2.5 cards','Team over 2.5','tka25','Teams facing them booked 3+',1,true,71),
  ('tka15','cards','team','Opponents booked 2+','Opponents 2+','tk15','Opponent booked 2+',1,false,72),
  ('tka25','cards','team','Opponents booked 3+','Opponents 3+','tk25','Opponent booked 3+',1,false,73)
on conflict (code) do update set stat = excluded.stat, scope = excluded.scope, label = excluded.label,
  chip = excluded.chip, mirror_code = excluded.mirror_code, mirror_label = excluded.mirror_label,
  direction = excluded.direction, listed = excluded.listed, sort_order = excluded.sort_order;

-- 3. Per club, per market: this season's record.
drop materialized view if exists public.mx_market_rankings;
drop materialized view if exists public.mx_team_market_rates;
create materialized view public.mx_team_market_rates as
with st as (
  select ms.fixture_id, ms.team_side,
    max(case when e->>'type' = 'Corner Kicks' and e->>'value' ~ '^[0-9]+$' then (e->>'value')::int end) as corners,
    max(case when e->>'type' = 'Yellow Cards' and e->>'value' ~ '^[0-9]+$' then (e->>'value')::int end) as yellows,
    max(case when e->>'type' = 'Red Cards'    and e->>'value' ~ '^[0-9]+$' then (e->>'value')::int end) as reds
  from public.match_stats ms, jsonb_array_elements(ms.stats) e
  group by ms.fixture_id, ms.team_side
), g as (
  select m.id, m.kickoff_at, m.league_id, m.home_team_id, m.away_team_id, m.goals_home gh, m.goals_away ga,
    h.corners hc, a.corners ac,
    case when h.corners is not null then coalesce(h.yellows, 0) + coalesce(h.reds, 0) end hk,
    case when a.corners is not null then coalesce(a.yellows, 0) + coalesce(a.reds, 0) end ak
  from public.matches m
  join public.leagues l on l.id = m.league_id
  left join st h on h.fixture_id = m.external_id and h.team_side = 'home'
  left join st a on a.fixture_id = m.external_id and a.team_side = 'away'
  where m.status = 'completed' and m.goals_home is not null and m.goals_away is not null
    and l.season_anchor is not null
    and m.kickoff_at >= public.league_season_start(l.season_anchor)
), tm as (
  select league_id, kickoff_at, home_team_id team_id, gh gf, ga gag, hc cf, ac ca, hk kf, ak ka from g
  union all
  select league_id, kickoff_at, away_team_id, ga, gh, ac, hc, ak, hk from g
), f as (
  select tm.team_id, tm.league_id, tm.kickoff_at, x.code, x.hit, x.val
  from tm cross join lateral (values
    ('o15',  (gf + gag >= 2)::int, (gf + gag)::numeric),
    ('o25',  (gf + gag >= 3)::int, (gf + gag)::numeric),
    ('o35',  (gf + gag >= 4)::int, (gf + gag)::numeric),
    ('u15',  (gf + gag <= 1)::int, (gf + gag)::numeric),
    ('u25',  (gf + gag <= 2)::int, (gf + gag)::numeric),
    ('u35',  (gf + gag <= 3)::int, (gf + gag)::numeric),
    ('btts', (gf > 0 and gag > 0)::int, (gf + gag)::numeric),
    ('bttsn',(not (gf > 0 and gag > 0))::int, (gf + gag)::numeric),
    ('cs',   (gag = 0)::int, gag::numeric),
    ('fts',  (gf = 0)::int, gf::numeric),
    ('tg15', (gf >= 2)::int, gf::numeric),
    ('tga15',(gag >= 2)::int, gag::numeric),
    ('c85',  (cf + ca >= 9)::int,  (cf + ca)::numeric),
    ('c95',  (cf + ca >= 10)::int, (cf + ca)::numeric),
    ('c105', (cf + ca >= 11)::int, (cf + ca)::numeric),
    ('cu85', (cf + ca <= 8)::int,  (cf + ca)::numeric),
    ('cu95', (cf + ca <= 9)::int,  (cf + ca)::numeric),
    ('cu105',(cf + ca <= 10)::int, (cf + ca)::numeric),
    ('tc35', (cf >= 4)::int, cf::numeric),
    ('tc45', (cf >= 5)::int, cf::numeric),
    ('tc55', (cf >= 6)::int, cf::numeric),
    ('tca35',(ca >= 4)::int, ca::numeric),
    ('tca45',(ca >= 5)::int, ca::numeric),
    ('tca55',(ca >= 6)::int, ca::numeric),
    ('k35',  (kf + ka >= 4)::int, (kf + ka)::numeric),
    ('k45',  (kf + ka >= 5)::int, (kf + ka)::numeric),
    ('k55',  (kf + ka >= 6)::int, (kf + ka)::numeric),
    ('ku35', (kf + ka <= 3)::int, (kf + ka)::numeric),
    ('ku45', (kf + ka <= 4)::int, (kf + ka)::numeric),
    ('tk15', (kf >= 2)::int, kf::numeric),
    ('tk25', (kf >= 3)::int, kf::numeric),
    ('tka15',(ka >= 2)::int, ka::numeric),
    ('tka25',(ka >= 3)::int, ka::numeric)
  ) as x(code, hit, val)
)
select team_id, code,
  mode() within group (order by league_id) as league_id,
  count(hit)::int as games,
  count(*)::int as played,
  coalesce(sum(hit), 0)::int as hits,
  round(avg(val), 3) as metric_avg,
  max(kickoff_at) as last_played
from f
group by team_id, code;

create unique index mx_team_market_rates_pk on public.mx_team_market_rates (team_id, code);

-- 4. The ranked rows, with the next fixture and the combined figure.
create materialized view public.mx_market_rankings as
with lr as (
  select league_id, code, sum(hits)::numeric / nullif(sum(games), 0) as rate
  from public.mx_team_market_rates group by league_id, code
), q as (
  select r.*, rm.mirror_code, rm.direction
  from public.mx_team_market_rates r
  join public.ranking_markets rm on rm.code = r.code and rm.listed
  where r.games >= 10 and r.games >= 0.8 * r.played and r.last_played > now() - interval '14 days'
), ranked as (
  select q.*,
    row_number() over (partition by q.code
      order by q.hits::numeric / q.games desc, q.games desc, q.direction * q.metric_avg desc nulls last, t.name) as rank,
    count(*) over (partition by q.code) as ranked_teams,
    t.name as team, l.name as league, l.country
  from q join public.teams t on t.id = q.team_id join public.leagues l on l.id = q.league_id
)
select r.code, r.rank::int, r.ranked_teams::int, r.team_id, r.team, r.league_id, r.league, r.country,
  r.games, r.played, r.hits, round(r.hits::numeric / r.games, 4) as hit_rate, r.metric_avg,
  round(lr.rate, 4) as league_rate,
  nx.match_id as next_match_id, nx.kickoff_at as next_kickoff_at, nx.venue as next_venue,
  nx.opp_id as opp_team_id, ot.name as opp_team, nl.name as next_competition,
  o.games as opp_games, o.hits as opp_hits,
  case when o.games >= 5 and lr.rate is not null and lr2.rate is not null then
    round(((r.hits + 5 * lr.rate) / (r.games + 5) + (o.hits + 5 * lr2.rate) / (o.games + 5)) / 2, 4) end as combined_rate,
  now() as refreshed_at
from ranked r
left join lr on lr.league_id = r.league_id and lr.code = r.code
left join lr lr2 on lr2.league_id = r.league_id and lr2.code = r.mirror_code
left join lateral (
  select m.id as match_id, m.kickoff_at,
    case when m.home_team_id = r.team_id then 'H' else 'A' end as venue,
    case when m.home_team_id = r.team_id then m.away_team_id else m.home_team_id end as opp_id,
    m.league_id as next_league_id
  from public.matches m
  where (m.home_team_id = r.team_id or m.away_team_id = r.team_id)
    and m.status = 'scheduled' and m.kickoff_at > now()
  order by m.kickoff_at limit 1
) nx on true
left join public.teams ot on ot.id = nx.opp_id
left join public.leagues nl on nl.id = nx.next_league_id
left join public.mx_team_market_rates o on o.team_id = nx.opp_id and o.code = r.mirror_code;

create unique index mx_market_rankings_pk on public.mx_market_rankings (code, rank);
create index mx_market_rankings_team on public.mx_market_rankings (team_id);

-- 5. What the page reads. Drops a next fixture that has kicked off since the
--    last refresh rather than showing a started match as "next".
create or replace view public.v_market_rankings with (security_invoker = true) as
select code, rank, ranked_teams, team_id, team, league_id, league, country,
  games, played, hits, hit_rate, metric_avg, league_rate,
  case when next_kickoff_at > now() then next_match_id end as next_match_id,
  case when next_kickoff_at > now() then next_kickoff_at end as next_kickoff_at,
  case when next_kickoff_at > now() then next_venue end as next_venue,
  case when next_kickoff_at > now() then opp_team_id end as opp_team_id,
  case when next_kickoff_at > now() then opp_team end as opp_team,
  case when next_kickoff_at > now() then next_competition end as next_competition,
  case when next_kickoff_at > now() then opp_games end as opp_games,
  case when next_kickoff_at > now() then opp_hits end as opp_hits,
  case when next_kickoff_at > now() then combined_rate end as combined_rate,
  refreshed_at
from public.mx_market_rankings;

revoke all on public.mx_team_market_rates, public.mx_market_rankings from anon, authenticated;
grant select on public.mx_market_rankings to anon, authenticated;
grant select on public.v_market_rankings to anon, authenticated;
comment on view public.v_market_rankings is
  'Season market rankings for /rankings. Settled history, public by ruling. combined_rate is a blend of two shrunk season records, never a probability. Migration 192.';

-- 6. Hourly refresh.
select cron.unschedule(jobid) from cron.job where jobname = 'market-rankings-refresh';
select cron.schedule('market-rankings-refresh', '33 * * * *',
  $$set statement_timeout = '5min'; refresh materialized view concurrently public.mx_team_market_rates; refresh materialized view concurrently public.mx_market_rankings;$$);
