-- 077_league_strength.sql — a per-league offset that puts ELO ratings from
-- different leagues on ONE scale, or refuses to.
--
-- THE PROBLEM. `team_elo` is a single pool, but ELO is zero-sum within a match,
-- so a set of clubs that only ever play each other conserves its own total and
-- sits at the 1500 default forever. Measured 19 Aug 2026, the share of each
-- league's completed games played against a club from a different league:
--
--     Major League Soccer      4,712 games    0.0%
--     Liga MX                  2,790          0.0%
--     J1 League                3,144          0.0%
--     Chinese Super League     2,410          0.0%
--     Premier League (Russia)  2,016          0.0%
--     Liga Profesional (Arg)   4,356          0.0%  (2 games)
--     Serie A (Brazil)         3,501          0.3%
--     Championship (England)   3,952         50.3%
--     Ligue 2 (France)         1,868         53.7%
--
-- So an MLS club on 1620 and a Premier League club on 1620 are not the same
-- thing, and eloProbs would call that fixture 50/50. Within a pool the ratings
-- are fine — which is why this never showed up on a domestic board — and it
-- bites the moment two pools are compared, which is exactly what a European tie
-- is.
--
-- THE FIT. theta_elo is added to a club's rating before the comparison:
--
--     d = (elo_home + theta[league_home] + home_adv) - (elo_away + theta[league_away])
--
-- and d then goes through lib/eloProbs.js unchanged — one draw model over one
-- rating scale, rather than a second correction bolted onto a vector that was
-- already wrong. theta was fitted by maximum likelihood of the realised 1X2
-- outcome over 1,521 cross-league fixtures (both clubs past 30 games,
-- point-in-time pre-match ratings replayed chronologically over `elo_corpus`),
-- by coordinate ascent with the Premier League pinned at zero — the offsets are
-- identified only up to a constant, so one league has to hold the origin.
--
--   log-likelihood   -1521.69 at theta = 0  ->  -1466.08 fitted
--   2*dLL = 111.2 on 22 df, p far below 0.001
--
-- FITTED TO OUTCOMES, NEVER TO A PRICE — the same rule as the draw model in
-- migration 075. No market number enters this fit at any point.
--
-- ONLY A GENUINELY INTER-LEAGUE COMPETITION MAY IDENTIFY AN OFFSET, and that
-- restriction is load-bearing rather than tidy. The first fit took any fixture
-- whose two clubs' domestic leagues differed, and produced Liga MX at +14 and
-- Spain's Segunda at +33 — both STRONGER than the Premier League, both from
-- leagues with no European football at all. The fixtures behind them were
-- ordinary Brazilian and Argentine league games in which one club had been
-- assigned the wrong domestic league, because `team_alias` had merged four
-- pairs of same-named clubs in different countries (below). A domestic league
-- match is by definition not cross-league; if the league assignment says
-- otherwise, the assignment is wrong. So the fit set is now drawn only from the
-- three UEFA competitions and the League Cup.
--
-- IT VALIDATES ITSELF. Nothing in the fit knows what a strong league is, and it
-- returns football's actual pecking order: Premier League 0, Bundesliga -38,
-- La Liga -49, Ligue 1 -64, Serie A -68, then the rest of Europe in order, with
-- the English pyramid falling out as 0 / -108 / -125 / -238.
--
-- ROBUSTNESS. The English lower divisions are identified almost entirely by the
-- League Cup (Championship 119 of 121 observations, League One 120 of 124,
-- League Two 104 of 104), where Premier League sides rotate heavily. Refitting
-- on UEFA ties alone — dropping 207 matches — moves every European offset by at
-- most 2.6 ELO points, except Sweden at 8.9; every one of those is far inside
-- standard errors of 18 to 67. The two competitions agree, so the League Cup is
-- not distorting the scale. `theta_uefa_only` records that refit, and is null
-- where a league has fewer than 20 UEFA observations and the refit therefore
-- says nothing about it.
--
-- IT FAILS CLOSED, AND THAT IS THE POINT. `status` is the contract:
--
--     reference       the pinned origin (Premier League, England)
--     fitted          theta_elo is usable
--     not_estimable   NO cross-league fixture exists — theta_elo is NULL
--
-- A caller must refuse to compare two leagues unless BOTH are reference or
-- fitted; lib/leagueStrength.js is that caller and returns null. The fourteen
-- not_estimable leagues are not a rounding error: MLS alone is thirty of the
-- next seven days' fixtures. Giving them theta = 0 would assert they are
-- Premier League strength, which is the exact failure this table exists to
-- prevent. Same-league fixtures need no offset at all — the two cancel — so a
-- domestic board is unaffected whatever the status says.

begin;

create table if not exists league_strength (
  league_id       uuid primary key references leagues(id),
  status          text not null check (status in ('reference','fitted','insufficient','not_estimable')),
  theta_elo       double precision,
  se_elo          double precision,
  ci_lo           double precision,
  ci_hi           double precision,
  n_obs           int  not null default 0,
  identified_by   text check (identified_by in ('uefa','league_cup','mixed')),
  theta_uefa_only double precision,
  model           text not null default 'ELO_LEAGUE_STRENGTH',
  version         text not null default 'v1',
  method          text,
  notes           text,
  fitted_at       timestamptz not null default now(),
  -- A theta exists if and only if the league is usable. No caller can read a
  -- number off an unusable row by accident.
  constraint league_strength_theta_iff_usable
    check ((status in ('reference','fitted')) = (theta_elo is not null))
);

comment on table league_strength is
  'Per-league ELO offsets putting ratings from different leagues on one scale. '
  'Fitted to realised outcomes over cross-league fixtures, never to a price. '
  'Compare two leagues ONLY when both are status reference or fitted. '
  'See migration 077 and docs/LEAGUE_STRENGTH.md.';

with v(league_name, country, status, theta, se, lo, hi, n, ident, theta_uefa) as (values
  ('Premier League',     'England',     'reference',    0.0, 18.4,  -16.0,   20.8, 356, 'mixed',       0.0),
  ('Bundesliga',         'Germany',     'fitted',     -38.1, 20.8,  -59.0,  -17.4, 242, 'uefa',      -37.2),
  ('La Liga',            'Spain',       'fitted',     -48.5, 20.8,  -69.7,  -28.0, 245, 'uefa',      -46.4),
  ('Ligue 1',            'France',      'fitted',     -64.0, 23.1,  -87.4,  -41.2, 196, 'uefa',      -63.0),
  ('Serie A',            'Italy',       'fitted',     -68.3, 20.6,  -89.3,  -48.1, 243, 'uefa',      -66.9),
  ('Jupiler Pro League', 'Belgium',     'fitted',     -81.7, 26.2, -108.3,  -55.9, 146, 'uefa',      -79.7),
  ('Primeira Liga',      'Portugal',    'fitted',    -100.1, 26.1, -126.4,  -74.2, 148, 'uefa',      -98.9),
  ('Championship',       'England',     'fitted',    -108.0, 30.9, -138.9,  -77.1, 121, 'league_cup', null),
  ('Superliga',          'Denmark',     'fitted',    -115.3, 36.6, -152.3,  -79.1,  79, 'uefa',     -114.5),
  ('League One',         'England',     'fitted',    -124.6, 30.5, -155.2,  -94.2, 124, 'league_cup', null),
  ('Eliteserien',        'Norway',      'fitted',    -129.6, 31.3, -161.3,  -98.6, 111, 'uefa',     -128.2),
  ('Ekstraklasa',        'Poland',      'fitted',    -134.9, 36.2, -171.6,  -99.2,  80, 'uefa',     -135.1),
  ('Eredivisie',         'Netherlands', 'fitted',    -144.6, 26.1, -170.9, -118.6, 155, 'uefa',     -143.4),
  ('Super League',       'Greece',      'fitted',    -151.2, 31.9, -183.5, -119.7, 104, 'uefa',     -150.0),
  ('Super League',       'Switzerland', 'fitted',    -159.5, 36.3, -196.4, -123.9,  88, 'uefa',     -157.2),
  ('Süper Lig',          'Turkey',      'fitted',    -167.8, 29.1, -197.3, -139.1, 124, 'uefa',     -166.6),
  ('Premiership',        'Scotland',    'fitted',    -175.0, 32.7, -207.9, -142.6,  98, 'uefa',     -173.0),
  ('Bundesliga',         'Austria',     'fitted',    -190.4, 36.1, -227.1, -154.8,  90, 'uefa',     -189.8),
  ('Liga I',             'Romania',     'fitted',    -200.3, 46.0, -247.0, -155.0,  48, 'uefa',     -199.1),
  ('Allsvenskan',        'Sweden',      'fitted',    -222.0, 39.3, -261.6, -183.1,  73, 'uefa',     -230.9),
  ('League Two',         'England',     'fitted',    -238.1, 33.4, -272.1, -205.2, 104, 'league_cup', null),
  ('Premier Division',   'Ireland',     'fitted',    -310.5, 67.1, -379.3, -245.2,  27, 'uefa',     -309.4),
  ('Veikkausliiga',      'Finland',     'fitted',    -327.5, 55.1, -383.8, -273.7,  40, 'uefa',     -324.9),

  -- NO cross-league fixture exists. Closed pools: their ratings are valid
  -- INSIDE the league and cannot be compared to anything outside it. Ligue 2,
  -- 2. Bundesliga and the Scottish Championship are here because their only
  -- apparent cross-league fixtures were the misclassified domestic ones
  -- described above. '1. Bundesliga' is the legacy duplicate league row for the
  -- German top flight (see migration 076) and should be merged into
  -- 'Bundesliga'/'Germany' rather than ever fitted.
  ('Major League Soccer','USA',         'not_estimable', null, null, null, null, 0, null, null),
  ('Liga MX',            'Mexico',      'not_estimable', null, null, null, null, 0, null, null),
  ('J1 League',          'Japan',       'not_estimable', null, null, null, null, 0, null, null),
  ('Super League',       'China',       'not_estimable', null, null, null, null, 0, null, null),
  ('Premier League',     'Russia',      'not_estimable', null, null, null, null, 0, null, null),
  ('Liga Profesional Argentina','Argentina','not_estimable', null, null, null, null, 0, null, null),
  ('Serie A',            'Brazil',      'not_estimable', null, null, null, null, 0, null, null),
  ('National League',    'England',     'not_estimable', null, null, null, null, 0, null, null),
  ('Segunda División',   'Spain',       'not_estimable', null, null, null, null, 0, null, null),
  ('Serie B',            'Italy',       'not_estimable', null, null, null, null, 0, null, null),
  ('Ligue 2',            'France',      'not_estimable', null, null, null, null, 0, null, null),
  ('2. Bundesliga',      'Germany',     'not_estimable', null, null, null, null, 0, null, null),
  ('Championship',       'Scotland',    'not_estimable', null, null, null, null, 0, null, null),
  ('1. Bundesliga',      'Germany',     'not_estimable', null, null, null, null, 0, null, null)
)
insert into league_strength
  (league_id, status, theta_elo, se_elo, ci_lo, ci_hi, n_obs, identified_by, theta_uefa_only, method, notes)
select l.id, v.status, v.theta, v.se, v.lo, v.hi, v.n, v.ident, v.theta_uefa,
  'maximum likelihood of the realised 1X2 outcome over cross-league fixtures in '
  'UEFA competitions and the League Cup; point-in-time pre-match ratings replayed '
  'over elo_corpus; coordinate ascent, Premier League (England) pinned at 0; '
  'se from the profile likelihood at dLL = 0.5',
  case v.status
    when 'not_estimable' then 'closed pool: no completed fixture against a club from another league'
    else null end
from v join leagues l on l.name = v.league_name and l.country = v.country
on conflict (league_id) do update set
  status = excluded.status, theta_elo = excluded.theta_elo, se_elo = excluded.se_elo,
  ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi, n_obs = excluded.n_obs,
  identified_by = excluded.identified_by, theta_uefa_only = excluded.theta_uefa_only,
  method = excluded.method, notes = excluded.notes, fitted_at = now();

-- Read-only to the browser roles, per the 'client key can no longer write
-- anything' rule.
revoke insert, update, delete on table league_strength from anon, authenticated;

commit;
