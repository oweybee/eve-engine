-- 080_current_league_is_forward_looking.sql — a club's league is where it is
-- playing, not where it last finished.
--
-- Migration 078 fixed this for DOMESTIC fixtures: Inter v Monza is a Serie A
-- match, so the competition names the league for both clubs and the offsets
-- cancel. That rule cannot help a CUP fixture, where the competition is exactly
-- what does not tell you the division — and there `team_scale` fell back to
-- "the most recent domestic league fixture the club COMPLETED", which in August
-- is last season's division for every promoted and relegated club.
--
-- Measured 19 Aug 2026, three League Cup ties six days out were affected:
--
--     Plymouth v Coventry    Coventry scaled as Championship  (-108) not PL (0)
--     Stoke City v Hull City Hull City   "        "               "
--     Ipswich v Leicester    Leicester   "        "               "
--
-- All three were promoted in the summer. A 108-point error on a live fixture,
-- in the same direction every time, and invisible: the forecast is wrong but
-- perfectly well-formed. Fifteen clubs in the database have changed division.
--
-- THE FIX IS A RULE, NOT A LIST. A club's league is the league of its SOONEST
-- UPCOMING domestic fixture, falling back to its most recent completed one only
-- when it has nothing scheduled. A fixture list is published before a season
-- starts, so a promoted club is correctly placed from the moment its calendar
-- lands — which `backfillSeasonFixtures.js` loads monthly — rather than after
-- it has played enough matches for a recency heuristic to catch up.
--
-- That also makes the whole thing self-updating, which the old rule was not: it
-- corrected itself only in arrears and only after the damage.

begin;

create or replace view team_scale with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World', 'International', 'Europe', 'Africa', 'South America')
    and name <> 'League Cup'
),
-- Every domestic league appearance, past and future. `matches` rather than
-- `elo_corpus` because the future half has no result yet and so is not in it.
appearances as (
  select km.canonical_key as k, m.league_id, m.kickoff_at
  from matches m
  join team_key_map km on km.team_id = m.home_team_id
  where m.league_id in (select id from domestic)
  union all
  select km.canonical_key, m.league_id, m.kickoff_at
  from matches m
  join team_key_map km on km.team_id = m.away_team_id
  where m.league_id in (select id from domestic)
),
-- WHERE THE CLUB IS PLAYING. Soonest upcoming fixture wins; if it has none
-- scheduled, the most recent one it played. The CASE orders future before past
-- and then by distance from now in each direction.
current_league as (
  select distinct on (k) k, league_id
  from appearances
  order by k,
           (kickoff_at > now()) desc,
           case when kickoff_at > now() then kickoff_at end asc,
           kickoff_at desc
),
meetings as (
  select home_key as k, away_key as opponent from elo_corpus
  union all
  select away_key,      home_key            from elo_corpus
),
orphan as (
  select m.k,
         count(*) filter (where ls.theta_elo is not null) as n_rated_opponents,
         avg(ls.theta_elo)                                as theta_elo
  from meetings m
  left join current_league cl on cl.k = m.opponent
  left join league_strength ls
         on ls.league_id = cl.league_id and ls.status in ('reference', 'fitted')
  where m.k not in (select k from current_league)
  group by m.k
)
select cl.k           as canonical_key,
       cl.league_id   as league_id,
       ls.theta_elo   as theta_elo,
       'league'::text as source,
       null::bigint   as n_rated_opponents,
       4              as min_rated_opponents,
       true           as is_usable,
       ls.status      as league_status
from current_league cl
join league_strength ls
  on ls.league_id = cl.league_id and ls.status in ('reference', 'fitted')

union all

select o.k, null, o.theta_elo, 'opponents', o.n_rated_opponents,
       4, (o.n_rated_opponents >= 4), null
from orphan o
where o.n_rated_opponents > 0;

comment on view team_scale is
  'Per-club ELO offset. A club''s league is the league of its SOONEST UPCOMING '
  'domestic fixture (migration 080) — where it is playing, not where it last '
  'finished, which mis-scaled every promoted club each August. source=league is '
  'the fitted league_strength value; source=opponents is a DERIVED estimate for '
  'a club with no domestic league. is_usable is the ONE definition of the '
  'opponent-count gate. NEVER consult this for a domestic league fixture: there '
  'the competition is the league for both clubs.';

-- Health check: a club whose scale-league disagrees with the division it is
-- actually about to play in. Should always be empty; it is how the August
-- promotion bug would have announced itself.
create or replace view team_scale_stale_league with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World', 'International', 'Europe', 'Africa', 'South America')
    and name <> 'League Cup'
),
next_fixture as (
  select distinct on (k) k, league_id, kickoff_at from (
    select km.canonical_key as k, m.league_id, m.kickoff_at
    from matches m join team_key_map km on km.team_id = m.home_team_id
    where m.league_id in (select id from domestic) and m.kickoff_at > now()
    union all
    select km.canonical_key, m.league_id, m.kickoff_at
    from matches m join team_key_map km on km.team_id = m.away_team_id
    where m.league_id in (select id from domestic) and m.kickoff_at > now()
  ) z order by k, kickoff_at asc
)
select ts.canonical_key, l1.name || ' (' || l1.country || ')' as scale_says,
       l2.name || ' (' || l2.country || ')' as next_fixture_is, nf.kickoff_at
from team_scale ts
join next_fixture nf on nf.k = ts.canonical_key
join leagues l1 on l1.id = ts.league_id
join leagues l2 on l2.id = nf.league_id
where ts.league_id is distinct from nf.league_id;

comment on view team_scale_stale_league is
  'Health check: a club scaled by a division it is not the one it is next '
  'scheduled to play in. Always empty. See migration 080.';

revoke all on table team_scale_stale_league from anon, authenticated;

commit;
