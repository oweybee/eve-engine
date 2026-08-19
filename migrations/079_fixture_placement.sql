-- 079_fixture_placement.sql — a fixture that cannot be placed says so, by name.
--
-- Two ties in the next thirty days cannot be put on the global ELO scale: both
-- clubs are untracked-nation sides whose only opponents are other untracked
-- sides, so there is nothing to anchor either of them to. The forecast for those
-- is correctly withheld — but until now it was withheld SILENTLY, and a fixture
-- that produces no number looks exactly like a fixture nobody asked about.
--
-- This repo has already ruled on that shape twice. `score_withheld_reason` on
-- `value_signals` strips the claim and RECORDS WHY; `/api/inplay` reports which
-- of four causes made it empty, because "returns nothing" and "cannot return
-- anything" are different facts and three features shipped dead when they were
-- confused. `fixture_placement` is the same idea for the ELO scale: every
-- upcoming fixture gets a verdict, and an unplaceable one carries a reason
-- naming the club that could not be placed.
--
-- ONE DEFINITION OF EACH RULE, which is why this migration also refactors.
--
--   • `team_key_map` — the team-id-to-canonical-key mapping was written inline
--     inside `elo_corpus` (migration 076), which was fine while `elo_corpus`
--     was the only thing that needed it. It is now needed for UPCOMING
--     fixtures too, which `elo_corpus` does not contain, so it becomes a view
--     of its own and `elo_corpus` reads it. The accent-folding string now
--     exists in exactly one place in SQL, matching lib/teamKey.js.
--
--   • `team_scale.is_usable` — the "a club placed only by its opponents needs
--     at least four rated ones" rule was about to live in the SQL view AND in
--     lib/leagueStrength.js. It is a column now, so both read it and neither
--     decides it. lib/leagueStrength keeps a numeric override for tests, but
--     its default is to trust this column.
--
-- A domestic league fixture is ALWAYS placed and never consults `team_scale`:
-- the competition is the league for both clubs, so the offsets cancel. See
-- migration 078 and the Inter v Monza case in its header.

begin;

-- ── the key mapping, extracted ─────────────────────────────────────────────
create or replace view team_key_map with (security_invoker = on) as
select t.id as team_id,
       t.name,
       coalesce(
         ta.canonical_key,
         -- lower() FIRST — translate is case-sensitive, and folding before
         -- lowering leaves every capital accented letter for the regexp to
         -- delete. That is the Saint-Étienne / Örgryte bug; see migration 076.
         regexp_replace(translate(lower(t.name),
           'àáâãäåāăąèéêëēĕėęěìíîïīįıòóôõöøōőùúûüūůűýÿñńňçćčšśşžźżďđðğģķļłřŕťţþ',
           'aaaaaaaaaeeeeeeeeeiiiiiiioooooooouuuuuuuyynnncccssszzzdddggkllrrttt'),
           '[^a-z0-9]', '', 'g')
       ) as canonical_key
from teams t
left join team_alias ta on ta.raw_name = t.name and ta.source = 'live_feed';

comment on view team_key_map is
  'team id -> canonical club key. The ONE place the alias lookup and accent '
  'folding are written in SQL; mirrors lib/teamKey.js. See migration 079.';

create or replace view elo_corpus with (security_invoker = on) as
with base as (
  select m.id, m.kickoff_at, m.result, m.league_id, m.external_id,
         kh.canonical_key as home_key, ka.canonical_key as away_key,
         kh.name as home_name, ka.name as away_name,
         (m.external_id ~ '^[0-9]+$') as is_apifootball
  from matches m
  join team_key_map kh on kh.team_id = m.home_team_id
  join team_key_map ka on ka.team_id = m.away_team_id
  where m.status = 'completed'
    and m.result in ('home', 'draw', 'away')
    and kh.canonical_key <> '' and ka.canonical_key <> ''
),
ranked as (
  select *, row_number() over (
    partition by home_key, away_key, kickoff_at::date
    order by is_apifootball desc, external_id
  ) as rk
  from base
)
select id, kickoff_at, result, league_id, home_key, away_key, home_name, away_name
from ranked where rk = 1;

-- ── the usability rule, made a column ──────────────────────────────────────
create or replace view team_scale with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World', 'International', 'Europe', 'Africa', 'South America')
    and name <> 'League Cup'
),
legs as (
  select home_key as k, league_id, kickoff_at from elo_corpus
  union all
  select away_key,      league_id, kickoff_at from elo_corpus
),
current_league as (
  select distinct on (k) k, league_id
  from legs where league_id in (select id from domestic)
  order by k, kickoff_at desc
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
  'Per-club ELO offset. source=league is the fitted league_strength value; '
  'source=opponents is a DERIVED first-order estimate for a club with no '
  'domestic league. is_usable is the ONE definition of the opponent-count gate '
  '— lib/leagueStrength.js reads it rather than re-deciding. A club absent from '
  'this view cannot be placed. NEVER consult it for a domestic league fixture: '
  'there the competition is the league for both clubs. See migrations 078, 079.';

-- ── the verdict, per upcoming fixture ──────────────────────────────────────
create or replace view fixture_placement with (security_invoker = on) as
with domestic as (
  select id from leagues
  where country not in ('World', 'International', 'Europe', 'Africa', 'South America')
    and name <> 'League Cup'
),
fx as (
  select m.id as match_id, m.kickoff_at, m.league_id,
         (m.league_id in (select id from domestic)) as competition_is_domestic_league,
         kh.canonical_key as home_key, ka.canonical_key as away_key,
         kh.name as home_name, ka.name as away_name
  from matches m
  join team_key_map kh on kh.team_id = m.home_team_id
  join team_key_map ka on ka.team_id = m.away_team_id
  where m.status <> 'completed' and m.kickoff_at > now()
)
select fx.match_id, fx.kickoff_at, fx.league_id,
       fx.home_name, fx.away_name,
       fx.competition_is_domestic_league,
       case
         when fx.competition_is_domestic_league then 'placed'
         when hs.is_usable and as2.is_usable    then 'placed'
         else 'unplaced'
       end as status,
       case
         when fx.competition_is_domestic_league then 'competition'
         when hs.is_usable and as2.is_usable
           then case when hs.source = 'league' and as2.source = 'league'
                     then 'league' else 'opponents' end
         else null
       end as basis,
       case
         when fx.competition_is_domestic_league or (hs.is_usable and as2.is_usable) then null
         else nullif(concat_ws('; ',
           case when hs.canonical_key is null
                then fx.home_name || ' has no place on the ELO scale — no domestic league in the corpus and no rated opponent'
                when not hs.is_usable
                then fx.home_name || ' is placed only by ' || hs.n_rated_opponents || ' rated opponent(s), under the ' || hs.min_rated_opponents || ' required'
           end,
           case when as2.canonical_key is null
                then fx.away_name || ' has no place on the ELO scale — no domestic league in the corpus and no rated opponent'
                when not as2.is_usable
                then fx.away_name || ' is placed only by ' || as2.n_rated_opponents || ' rated opponent(s), under the ' || as2.min_rated_opponents || ' required'
           end), '')
       end as unplaced_reason
from fx
left join team_scale hs  on hs.canonical_key  = fx.home_key
left join team_scale as2 on as2.canonical_key = fx.away_key;

comment on view fixture_placement is
  'Per-upcoming-fixture verdict on whether the two clubs can be put on one ELO '
  'scale, and a reason NAMING THE CLUB when they cannot. A withheld forecast '
  'must be distinguishable from a fixture nobody asked about — the same rule as '
  'value_signals.score_withheld_reason and the /api/inplay source block. '
  'See migration 079.';

revoke all on table team_key_map      from anon, authenticated;
revoke all on table fixture_placement from anon, authenticated;

commit;
