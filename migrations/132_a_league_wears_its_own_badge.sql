-- 132 — a league wears its own badge
--
-- NOT YET APPLIED.
--
-- The fixtures board groups by competition and had nothing to draw for one but
-- a three-letter code cut from the name: EPL, CHA, LAL, SEA, ERE. Every club on
-- the same board carries its crest, because migration 109 gave `teams` an
-- `external_id` and a `crest_url` and `planDay` has written both on every
-- ingest since. `leagues` held id, name, country, created_at and nothing else,
-- so there was nowhere for the equivalent to go.
--
-- ── WHY THE BACKFILL IS SQL AND NOT A SCRIPT ────────────────────────────
--
-- `backfillTeamCrests.js` exists because clubs had NO shared key with the
-- provider: filling one in was the whole job, the match had to be made on name,
-- and that matcher is the part with three audited false merges in it.
--
-- Leagues have the opposite problem, which is no problem. `lib/trackedLeagues`
-- IS the mapping — every row in it is `[apiId, name, country, corpusKey]`, and
-- `leagues` is keyed on exactly (name, country) since migration 044. There is
-- nothing to infer and nothing to guess wrong, so the pairs below are that
-- list transcribed, and a name that matches no row updates nothing.
--
-- The URL is derived rather than fetched. Every crest already in `teams` reads
-- `https://media.api-sports.io/football/teams/{external_id}.png`, and the
-- league path is the same shape with `leagues` in it. All 46 ids below were
-- requested on 8 Oct 2026: 46 of 46 returned 200, and all 46 returned a
-- DISTINCT image, so none of them is a shared placeholder standing in for a
-- competition the provider has no art for.
--
-- ── external_id IS NOT UNIQUE HERE, AND THAT IS DELIBERATE ──────────────
--
-- Migration 109 made `teams.external_id` unique because each row there is one
-- SPELLING of a club and exactly one may carry the id. `leagues` holds eight
-- rows that predate the current ingest and name a competition the tracked list
-- also names: `1. Bundesliga` and `Bundesliga` are both Germany's top flight,
-- `Champions League` and `UEFA Champions League` are both id 2. Those rows own
-- real matches and real settled results, so they are not deletable here, and a
-- unique constraint would refuse the badge to whichever of the pair came
-- second. Both get the id, and both draw the right badge.
--
-- ── TWO BADGES CARRY A YEAR ─────────────────────────────────────────────
--
-- id 4 is stamped EURO 2024 GERMANY and id 9 COPA AMERICA USA 2024: the
-- provider publishes the edition, not the competition. Both are dormant rows
-- with nothing upcoming, so nothing on today's board draws them, but they will
-- read as stale the day either tournament returns. The ingest below overwrites
-- `logo_url` on every run, so the fix when that day comes is to let it run.

begin;

alter table public.leagues add column if not exists external_id text;
alter table public.leagues add column if not exists logo_url   text;

comment on column public.leagues.external_id is
  'API-Football league id. Not unique: legacy rows name the same competition.';
comment on column public.leagues.logo_url is
  'Competition badge, https://media.api-sports.io/football/leagues/{external_id}.png';

-- The tracked set (lib/trackedLeagues.js), plus the eight legacy spellings.
with pairs(api_id, name, country) as (
  values
    -- England
    (39,  'Premier League',              'England'),
    (40,  'Championship',                'England'),
    (41,  'League One',                  'England'),
    (42,  'League Two',                  'England'),
    (43,  'National League',             'England'),
    (48,  'League Cup',                  'England'),
    -- Scotland
    (179, 'Premiership',                 'Scotland'),
    (180, 'Championship',                'Scotland'),
    -- Big five
    (78,  'Bundesliga',                  'Germany'),
    (79,  '2. Bundesliga',               'Germany'),
    (140, 'La Liga',                     'Spain'),
    (141, 'Segunda División',            'Spain'),
    (135, 'Serie A',                     'Italy'),
    (136, 'Serie B',                     'Italy'),
    (61,  'Ligue 1',                     'France'),
    (62,  'Ligue 2',                     'France'),
    -- Rest of Europe
    (88,  'Eredivisie',                  'Netherlands'),
    (94,  'Primeira Liga',               'Portugal'),
    (203, 'Süper Lig',                   'Turkey'),
    (197, 'Super League',                'Greece'),
    (144, 'Jupiler Pro League',          'Belgium'),
    (218, 'Bundesliga',                  'Austria'),
    (207, 'Super League',                'Switzerland'),
    (119, 'Superliga',                   'Denmark'),
    (103, 'Eliteserien',                 'Norway'),
    (113, 'Allsvenskan',                 'Sweden'),
    (244, 'Veikkausliiga',               'Finland'),
    (106, 'Ekstraklasa',                 'Poland'),
    (283, 'Liga I',                      'Romania'),
    (235, 'Premier League',              'Russia'),
    (357, 'Premier Division',            'Ireland'),
    -- Americas and Asia
    (253, 'Major League Soccer',         'USA'),
    (262, 'Liga MX',                     'Mexico'),
    (71,  'Serie A',                     'Brazil'),
    (128, 'Liga Profesional Argentina',  'Argentina'),
    (98,  'J1 League',                   'Japan'),
    (169, 'Super League',                'China'),
    -- International
    (2,   'UEFA Champions League',         'World'),
    (3,   'UEFA Europa League',            'World'),
    (848, 'UEFA Europa Conference League', 'World'),
    -- Legacy spellings still holding matches and settled results
    (78,  '1. Bundesliga',               'Germany'),
    (72,  'Brazil Serie B',              'Brazil'),
    (2,   'Champions League',            'Europe'),
    (4,   'UEFA Euro',                   'Europe'),
    (1,   'FIFA World Cup',              'International'),
    (6,   'African Cup of Nations',      'Africa'),
    (9,   'Copa América',                'South America'),
    (13,  'Copa Libertadores',           'South America')
)
update public.leagues l
   set external_id = p.api_id::text,
       logo_url    = 'https://media.api-sports.io/football/leagues/' || p.api_id || '.png'
  from pairs p
 where l.name = p.name
   and l.country = p.country;

commit;

-- Acceptance. Expect 48 of 48 rows carrying a badge, and nothing in the second
-- query, which is the set of competitions with a fixture inside a fortnight and
-- no badge to draw beside it.
--
--   select count(*) filter (where logo_url is not null) as with_badge,
--          count(*) as rows
--     from public.leagues;
--
--   select distinct l.name, l.country
--     from public.matches m
--     join public.leagues l on l.id = m.league_id
--    where m.kickoff_at between now() and now() + interval '14 days'
--      and l.logo_url is null;
