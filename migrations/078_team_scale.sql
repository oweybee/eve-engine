-- 078_team_scale.sql — every club gets an offset, or a stated reason it cannot.
--
-- Migration 077 keyed the ELO offset by LEAGUE and refused any pair it could not
-- place. Measured against the next thirty days of fixtures, that refused 111 of
-- 1,472 — and almost all of it was neither a missing offset nor a real refusal.
--
-- 1. THE BIG ONE WAS A LOOKUP BUG, NOT A GAP. A club's league was read as "the
--    division it last completed a season in". In August that is wrong for every
--    promoted and relegated club: Inter v Monza is a SERIE A fixture, but Monza
--    last completed a season in Serie B, so the pair looked cross-league, the
--    two offsets failed to cancel, and the forecast was shifted by 100+ points
--    on an ordinary domestic match. 47 fixtures, all of them Serie A/Serie B,
--    La Liga/Segunda, Ligue 1/Ligue 2 and Bundesliga/2. Bundesliga.
--
--    THE COMPETITION IS THE LEAGUE. If a fixture IS a Serie A match then both
--    clubs are Serie A clubs that day, whatever they did last May. `team_scale`
--    below is only ever consulted for a fixture that is NOT a domestic league
--    match; lib/leagueStrength.js enforces that and it is the whole fix for
--    this class. It is the same principle the 077 fit already used: a domestic
--    league match is by definition not cross-league.
--
-- 2. THE `not_estimable` LEAGUES REFUSED NOTHING AT ALL. MLS, Liga MX, J1, the
--    Chinese Super League, the Russian Premier League and Argentina are closed
--    pools — that is WHY they have no offset — and a closed pool never produces
--    a cross-league fixture. Zero of the 1,472 were refused on their account.
--    The refusal is vacuous for exactly the leagues that look worst on paper,
--    and their domestic boards were never affected because same-league offsets
--    cancel.
--
-- 3. WHAT REMAINED WAS 48 FIXTURES WHERE A CLUB HAS NO LEAGUE AT ALL — the
--    untracked-nation clubs that appear only in European ties (see
--    docs/ELO_CALIBRATION.md §7). 314 such clubs are in the corpus.
--
--    Those need no LEAGUE offset, because they have no closed pool to correct:
--    every game they have ever played in our data is a cross-pool tie, so their
--    rating is already anchored to the global ladder. What they inherit instead
--    is their OPPONENTS' inflation. A Faroese club that has only played
--    Norwegian sides earned its rating against ratings that are themselves
--    ~130 points high, so it carries ~130 points of the same error.
--
--    So the estimate is the meetings-weighted mean theta of the opponents it has
--    actually faced. It is a first-order correction, not a fit — recorded as
--    source='opponents' so no caller can mistake it for one — and it comes with
--    n_rated_opponents so a thin one can be gated. 161 of the 314 have at least
--    one rated opponent and 106 have four or more; the rest have only ever
--    played other unplaced clubs, and those are still refused.
--
-- A VIEW, NOT A TABLE. The league offsets in 077 are FITTED and are therefore
-- data, frozen until refitted. These are DERIVED — a deterministic function of
-- elo_corpus and league_strength — so a view cannot go stale, and a new
-- European tie improves a club's estimate the moment it settles.
--
-- Coverage over the next thirty days after all three: 1,424 fixtures need no
-- offset at all, 40 more resolve on an opponent-derived offset with four or
-- more rated opponents, 8 on a thinner one, and TWO remain unresolvable.

begin;

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
-- A club's CURRENT domestic league: the most recent domestic league fixture it
-- played. Used only for a cup or European tie; a domestic league fixture takes
-- its league from the competition instead (see the header).
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
select cl.k                as canonical_key,
       cl.league_id        as league_id,
       ls.theta_elo        as theta_elo,
       'league'::text      as source,
       null::int           as n_rated_opponents,
       ls.status           as league_status
from current_league cl
join league_strength ls
  on ls.league_id = cl.league_id and ls.status in ('reference', 'fitted')

union all

select o.k, null, o.theta_elo, 'opponents', o.n_rated_opponents, null
from orphan o
where o.n_rated_opponents > 0;

comment on view team_scale is
  'Per-club ELO offset. source=league is the fitted league_strength value; '
  'source=opponents is a DERIVED first-order estimate for a club with no '
  'domestic league — the meetings-weighted mean theta of the opponents it has '
  'played — and carries n_rated_opponents so a thin one can be gated. A club '
  'absent from this view cannot be placed on the global scale. NEVER consult it '
  'for a domestic league fixture: there the competition is the league for both '
  'clubs. See migration 078.';

revoke all on table team_scale from anon, authenticated;

commit;
