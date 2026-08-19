-- 076_elo_corpus.sql — one row per real fixture, one row per real club.
--
-- WHAT WAS WRONG. computeElo walks `matches` chronologically and applies an ELO
-- update per row. Measured 19 Aug 2026, `matches` held 92,491 completed rows for
-- 86,292 real fixtures: 6,199 of them — 6.7% — were the SAME match ingested
-- twice, and every one applied its rating update twice.
--
-- The cause is that `matches` upserts on `external_id`, and the same fixture
-- arrives under different id schemes. A historical corpus (`datahub_*`, loaded
-- 21 Jun 2026) covers EPL / La Liga / Serie A / Ligue 1 / Bundesliga from 2005
-- to May 2025; API-Football (numeric ids) covers 2022 onward; in the overlap
-- both exist. Betfair (`bf_*`) and The Odds API (32-hex) add a few more.
--
-- IT WAS INVISIBLE BECAUSE THE CLUBS WERE SPLIT TOO. The two feeds name clubs
-- differently — "Tottenham Hotspur" and "Tottenham", "Inter Milan" and "Inter",
-- "Wolverhampton Wanderers" and "Wolves" — so the duplicate pair often carried
-- two different `home_team_id`s and did not even look like a duplicate. It also
-- meant the ladder held TWO ratings for one club, one of them frozen in 2025.
--
-- THE MAPPING ALREADY EXISTED AND NOTHING WAS USING IT HERE. `team_alias`
-- (migration 053) is this repo's one answer to "which names are one club",
-- audited across both sources on 5 Aug over 1,065 distinct clubs. It resolved 21
-- of the 37 pairs the ELO ladder needed and, once pointed at, 95 fixtures more
-- than a purpose-built detector found. So this migration does NOT add a second
-- alias table — lib/teamNames.js says plainly that two matchers "must agree
-- forever and will not". It TOPS UP the existing one and reads from it.
--
-- The seventeen rows added below are:
--
--   • sixteen pairs `buildTeamAliases` never matched, each derived from the
--     fixtures rather than typed: where a datahub match and an API-Football
--     match share a kickoff date and ONE team id, the other two rows are the
--     same club. Backed by 10 to 108 co-occurring fixtures apiece.
--   • `Saint-Étienne`, which resolved to `sainttienne` — the É is dropped
--     instead of folded, so it never met `Saint Etienne`. That is a CAPITAL
--     accent, and the same bug appeared twice more the same day: in the first
--     draft of this view, and in computeElo's own key, which deleted every
--     accented letter and split twenty clubs including Atlético Madrid.
--     lib/teamKey.js is the rule that fixes the class; this row fixes the
--     instance already stored.
--
-- They are written with method='manual' — not because a human typed them (they
-- are derived, and the derivation is above) but because that is the only flag
-- buildTeamAliases refuses to overwrite. Under any other method the next run of
-- that job writes its own `exact` slug back over these rows and re-splits every
-- club. The provenance lives in this comment; the durability has to live in the
-- column. The insert's WHERE clause likewise declines to touch a pre-existing
-- manual row.
--
-- FOUR FALSE MERGES FELL OUT OF THIS, AND THEY WERE ALREADY THERE. Deduplicating
-- by canonical key made a new test possible: two clubs that have PLAYED EACH
-- OTHER cannot be the same club, so a fixture whose home and away keys are equal
-- is a merge that should never have happened. It found four, every one from
-- buildTeamAliases' `prefix` pass and every one a derby:
--
--     Los Angeles FC   folded into  Los Angeles Galaxy   (12 fixtures)
--     Dundee           folded into  Dundee Utd           ( 7)
--     FC Tokyo         folded into  Tokyo Verdy          ( 6)
--     Paris FC         folded into  Paris Saint Germain  ( 2)
--
-- A SECOND INVARIANT CAUGHT FOUR MORE, and these could never have shown up as a
-- derby because the two clubs can never meet: a club does not play domestic
-- league football in two countries. Also all `prefix`, 1,166 games between them:
--
--     Racing Club (Argentina)   folded into  Racing Santander (Spain)  (328)
--     Rapid Bucuresti (Romania) folded into  Rapid Vienna (Austria)    (300)
--     Santos (Brazil)           folded into  Santos Laguna (Mexico)    (283)
--     Club America (Mexico)     folded into  America Mineiro (Brazil)  (255)
--
-- Those four are why the first league-strength fit returned Liga MX as STRONGER
-- than the Premier League: a phantom club gave two continents a shared rating.
-- See migration 077.
--
-- lib/teamNames.js already documents three of exactly this shape (AC Ajaccio
-- into Ajaccio GFCO, Guinea into Guinea-Bissau, Virtus into Virtus Entella).
-- All eight are unmerged below, and `team_alias_false_merges` and
-- `team_alias_cross_country` make both tests permanent, in the shape of
-- `uncalibrated_writers`: they should always be empty, and the migration
-- refuses to commit if either is not.
--
-- This is not an ELO-only fix. `mx_team_form` partitions by canonical key too,
-- so for as long as those rows stood, LAFC's form was Galaxy's.
--
-- NOTHING IS DELETED and no ingest path changes. `matches` keeps every row.

begin;

insert into team_alias (source, raw_name, canonical_key, method)
values
  ('live_feed', 'Inter Milan',              'inter',                     'manual'),
  ('live_feed', 'Brest',                    'stadebrestois29',           'manual'),
  ('live_feed', 'Athletic Bilbao',          'athletic',                  'manual'),
  ('live_feed', 'Betis',                    'realbetis',                 'manual'),
  ('live_feed', 'Celta',                    'celtavigo',                 'manual'),
  ('live_feed', 'Espanol',                  'espanyol',                  'manual'),
  ('live_feed', 'Deportivo Alavés',         'alaves',                    'manual'),
  ('live_feed', 'Sheffield United',         'sheffieldutd',              'manual'),
  ('live_feed', 'Hoffenheim',               '1899hoffenheim',            'manual'),
  ('live_feed', 'Ein Frankfurt',            'eintrachtfrankfurt',        'manual'),
  ('live_feed', 'Leverkusen',               'bayerleverkusen',           'manual'),
  ('live_feed', 'Troyes',                   'estactroyes',               'manual'),
  ('live_feed', 'M''gladbach',              'borussiamonchengladbach',   'manual'),
  ('live_feed', 'Bochum',                   'vflbochum',                 'manual'),
  ('live_feed', 'Bayern Munich',            'bayernmunchen',             'manual'),
  ('live_feed', 'Saint-Étienne',            'saintetienne',              'manual'),
  -- The four false merges. Each gets its own key back.
  ('live_feed', 'Los Angeles FC',           'losangelesfc',              'manual'),
  ('live_feed', 'Dundee',                   'dundee',                    'manual'),
  ('live_feed', 'FC Tokyo',                 'fctokyo',                   'manual'),
  ('live_feed', 'Paris FC',                 'parisfc',                   'manual'),
  -- and four merged ACROSS COUNTRIES, which the derby test cannot catch
  -- because these pairs can never meet.
  ('live_feed', 'Racing Club',              'racingclub',                'manual'),
  ('live_feed', 'Rapid',                    'rapid',                     'manual'),
  ('live_feed', 'Santos',                   'santos',                    'manual'),
  ('live_feed', 'Club America',             'clubamerica',               'manual')
on conflict (source, raw_name) do update
  set canonical_key = excluded.canonical_key,
      method        = excluded.method,
      updated_at    = now()
  where team_alias.method <> 'manual';

-- ── the corpus ─────────────────────────────────────────────────────────────
-- A club's key is its `team_alias` canonical_key where one exists, and the
-- accent-folded name otherwise — the same rule as lib/teamKey.js, which is why
-- that file says to keep the two in step. Then ONE row per (home, away, date):
-- API-Football wins a tie because it is the feed still being written, the
-- datahub rows being a frozen historical import.
create or replace view elo_corpus with (security_invoker = on) as
with resolved as (
  select t.id as team_id, t.name,
    coalesce(
      ta.canonical_key,
      -- lower() FIRST. translate is case-sensitive, so folding before lowering
      -- leaves every capital accented letter untouched and the regexp then
      -- deletes it. That is the Saint-Étienne bug, and it shipped in the first
      -- draft of this very view ('Örgryte IS' keyed as 'rgryteis').
      regexp_replace(translate(lower(t.name),
        'àáâãäåāăąèéêëēĕėęěìíîïīįıòóôõöøōőùúûüūůűýÿñńňçćčšśşžźżďđðğģķļłřŕťţþ',
        'aaaaaaaaaeeeeeeeeeiiiiiiioooooooouuuuuuuyynnncccssszzzdddggkllrrttt'),
        '[^a-z0-9]', '', 'g')
    ) as k
  from teams t
  left join team_alias ta on ta.raw_name = t.name and ta.source = 'live_feed'
),
base as (
  select m.id, m.kickoff_at, m.result, m.league_id, m.external_id,
         rh.k as home_key, ra.k as away_key,
         rh.name as home_name, ra.name as away_name,
         (m.external_id ~ '^[0-9]+$') as is_apifootball
  from matches m
  join resolved rh on rh.team_id = m.home_team_id
  join resolved ra on ra.team_id = m.away_team_id
  where m.status = 'completed'
    and m.result in ('home', 'draw', 'away')
    and rh.k <> '' and ra.k <> ''
),
ranked as (
  select *, row_number() over (
    partition by home_key, away_key, kickoff_at::date
    order by is_apifootball desc, external_id
  ) as rk
  from base
)
select id, kickoff_at, result, league_id,
       home_key, away_key, home_name, away_name
from ranked
where rk = 1;

comment on view elo_corpus is
  'Completed fixtures, deduplicated and with club identities resolved through '
  'team_alias. This is what computeElo walks — `matches` double-counts 6.7% of '
  'completed rows and splits clubs across two ids. See migration 076.';

-- ── the invariant ──────────────────────────────────────────────────────────
-- Two clubs that played each other are not one club. Should always be empty.
create or replace view team_alias_false_merges with (security_invoker = on) as
select home_key as canonical_key, home_name, away_name, count(*) as fixtures,
       min(kickoff_at)::date as first_seen, max(kickoff_at)::date as last_seen
from elo_corpus
where home_key = away_key
group by 1, 2, 3;

comment on view team_alias_false_merges is
  'Health check: a fixture whose two clubs resolve to ONE canonical key is a '
  'false merge in team_alias. Always empty. `select * from '
  'team_alias_false_merges` after any buildTeamAliases run.';

create or replace view team_alias_cross_country with (security_invoker = on) as
with legs as (
  select home_key k, league_id from elo_corpus
  union all select away_key, league_id from elo_corpus
)
select l.k as canonical_key,
       string_agg(distinct lg.country, ', ' order by lg.country) as countries,
       count(*) as games,
       (select string_agg(distinct ta.raw_name, ' ~ ') from team_alias ta
        where ta.canonical_key = l.k) as names
from legs l
join leagues lg on lg.id = l.league_id
where lg.country not in ('World','International','Europe','Africa','South America')
group by l.k
having count(distinct lg.country) > 1;

comment on view team_alias_cross_country is
  'Health check: a club does not play domestic league football in two '
  'countries, so a canonical key spanning two is a false merge in team_alias. '
  'Always empty. Sibling of team_alias_false_merges — that one catches clubs '
  'that played each other, this one catches clubs that never could.';

do $$
declare n int;
begin
  select count(*) into n from team_alias_false_merges;
  if n > 0 then
    raise exception 'team_alias still merges % pair(s) of clubs that have played each other', n;
  end if;
  select count(*) into n from team_alias_cross_country;
  if n > 0 then
    raise exception 'team_alias still merges % club(s) across countries', n;
  end if;
end $$;

-- Engine-side only. Migration 059 is the precedent for security_invoker on
-- every view.
revoke all on table elo_corpus               from anon, authenticated;
revoke all on table team_alias_false_merges  from anon, authenticated;
revoke all on table team_alias_cross_country from anon, authenticated;

commit;
