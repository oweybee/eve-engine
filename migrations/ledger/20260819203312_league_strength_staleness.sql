-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260819203312, name league_strength_staleness. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace view league_strength_staleness with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World','International','Europe','Africa','South America')
    and name <> 'League Cup'
),
inter as (
  select id from leagues
  where name in ('UEFA Champions League','UEFA Europa League',
                 'UEFA Europa Conference League','League Cup')
),
seasoned as (
  select c.id, c.kickoff_at, c.league_id, c.home_key, c.away_key,
         extract(year from (c.kickoff_at - interval '6 months'))::int as season
  from elo_corpus c
  where c.league_id in (select id from inter)
),
legs as (
  select home_key k, extract(year from (kickoff_at - interval '6 months'))::int season,
         league_id from elo_corpus
  union all
  select away_key, extract(year from (kickoff_at - interval '6 months'))::int, league_id from elo_corpus
),
tsl as (
  select distinct on (k, season) k, season, league_id
  from (select k, season, league_id, count(*) c from legs
        where league_id in (select id from domestic) group by 1,2,3) z
  order by k, season, c desc
),
cross_obs as (
  select s.id, s.kickoff_at, hl.league_id as h_lg, al.league_id as a_lg
  from seasoned s
  join tsl hl on hl.k = s.home_key and hl.season = s.season
  join tsl al on al.k = s.away_key and al.season = s.season
  where hl.league_id <> al.league_id
),
per_league as (
  select lg, count(*) as total,
         count(*) filter (where kickoff_at > ls.fitted_at) as since_fit
  from (select h_lg lg, kickoff_at from cross_obs
        union all select a_lg, kickoff_at from cross_obs) z
  join league_strength ls on ls.league_id = z.lg
  group by lg
)
select l.name || ' (' || l.country || ')' as league,
       ls.status, round(ls.theta_elo::numeric, 1) as theta_elo,
       ls.n_obs as n_obs_at_fit, p.total as n_obs_now,
       coalesce(p.since_fit, 0) as new_since_fit,
       ls.fitted_at,
       round((100.0 * coalesce(p.since_fit, 0) / nullif(ls.n_obs, 0))::numeric, 1) as pct_new
from league_strength ls
join leagues l on l.id = ls.league_id
left join per_league p on p.lg = ls.league_id
where coalesce(p.since_fit, 0) > 0
   or (ls.status = 'not_estimable' and coalesce(p.total, 0) > 0);

comment on view league_strength_staleness is
  'How much cross-league evidence has landed since league_strength was last '
  'fitted. Empty means the offsets are current. A league appearing with '
  'status=not_estimable and n_obs_now > 0 has become fittable and is being '
  'refused for no reason any more. Refit with fitLeagueStrength.js. '
  'See migration 080.';

revoke all on table league_strength_staleness from anon, authenticated;
