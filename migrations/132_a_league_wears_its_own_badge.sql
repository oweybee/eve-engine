-- 132 — a league wears its country's flag, and keeps its own badge behind it
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
alter table public.leagues add column if not exists flag_url   text;

comment on column public.leagues.external_id is
  'API-Football league id. Not unique: legacy rows name the same competition.';
comment on column public.leagues.logo_url is
  'Competition badge, https://media.api-sports.io/football/leagues/{external_id}.png';
comment on column public.leagues.flag_url is
  'The country flag the board draws. Null for the four rows whose country is not one.';

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

-- ── AND THE FLAG, WHICH IS WHAT THE BOARD ACTUALLY DRAWS ────────────────
--
-- Owner, 8 Oct: the country flag rather than the competition badge. It is the
-- better mark at 22px. A league badge is a crest with lettering in it — UEFA
-- CHAMPIONS LEAGUE around a ball, BUNDESLIGA in white on red — drawn to be
-- read at poster size, and at the size of a group heading all forty are a
-- smudge. A flag is three or four flat shapes and is legible at any size, and
-- the question a reader is answering while scanning headings is which country
-- they are looking at.
--
-- SAME DERIVED URL, A DIFFERENT PATH. `/flags/{code}.svg`, and the codes are
-- ISO 3166-1 alpha-2 with the three Home Nations carrying the provider's own
-- `gb-eng` / `gb-sct` / `gb-wls` sub-codes, because England and Scotland are
-- not `gb`. All 27 below were requested on 8 Oct and all 27 returned 200.
--
-- NINE ROWS GET NO FLAG AND THAT IS NOT A GAP. Their country is World, Europe,
-- International, South America or Africa, none of which is a country, and
-- inventing a flag for a continent is inventing a fact. Those nine keep the
-- competition badge above, which is the right mark for them anyway: the
-- Champions League, the Euro and the Libertadores each have one that IS the
-- competition rather than a league's wordmark. Three of the nine have a
-- fixture inside a fortnight (the UEFA set, filed under World), so this
-- fallback is load-bearing on an ordinary week and not a corner.
--
-- Flag, then badge, then the letters.
update public.leagues set flag_url =
  'https://media.api-sports.io/flags/' || c.code || '.svg'
from (values
  ('England','gb-eng'), ('Scotland','gb-sct'), ('Wales','gb-wls'),
  ('Spain','es'),       ('Italy','it'),        ('Germany','de'),
  ('France','fr'),      ('Netherlands','nl'),  ('Portugal','pt'),
  ('Turkey','tr'),      ('Greece','gr'),       ('Belgium','be'),
  ('Austria','at'),     ('Switzerland','ch'),  ('Denmark','dk'),
  ('Norway','no'),      ('Sweden','se'),       ('Finland','fi'),
  ('Poland','pl'),      ('Romania','ro'),      ('Russia','ru'),
  ('Ireland','ie'),     ('USA','us'),          ('Mexico','mx'),
  ('Brazil','br'),      ('Argentina','ar'),    ('Japan','jp'),
  ('China','cn')
) as c(country, code)
where public.leagues.country = c.country;

commit;

-- Acceptance. Expect 48 rows with a badge and 39 with a flag — the nine
-- without are the World / Europe / International / South America / Africa
-- rows, which are the nine that keep the badge. The second query should return nothing: it is the
-- set of competitions with a fixture inside a fortnight and no mark at all to
-- draw beside them.
--
--   select count(*) filter (where logo_url is not null) as with_badge,
--          count(*) filter (where flag_url is not null) as with_flag,
--          count(*) as rows
--     from public.leagues;
--
--   select distinct l.name, l.country
--     from public.matches m
--     join public.leagues l on l.id = m.league_id
--    where m.kickoff_at between now() and now() + interval '14 days'
--      and l.flag_url is null and l.logo_url is null;
