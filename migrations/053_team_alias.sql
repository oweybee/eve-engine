-- 053_team_alias.sql
--
-- STAGED, NOT APPLIED — and APPLY THIS BEFORE 051, despite the number. 051's
-- `mx_refresh_team_match()` now calls `mx_canonical_team()`, which this file
-- creates. Applying 051 first leaves a function that references one that does
-- not exist; it will create fine and fail on first call.
--
-- §2.3 of the 2026-08-05 brief asks for `fixture_mapping` to be filled, on the
-- grounds that it "joins football-data team names to feed names". IT DOES NOT.
-- Its actual schema is
--
--     odds_api_event_id (pk) · api_football_fixture_id · home_team · away_team
--     · kickoff_at · created_at
--
-- which is a FIXTURE-level bridge between The Odds API and API-Football, with
-- the team names present only as part of the join key. Nothing in either repo
-- reads it. Filling it with team-name pairs would mean putting one kind of data
-- in a table named for another — the precise bug the whole audit is about — and
-- the NOT NULL `odds_api_event_id` primary key makes it impossible anyway.
--
-- So the mapping gets its own table, and `fixture_mapping` is left alone for
-- the purpose its columns describe.
--
-- WHAT THE MAPPING IS FOR, MEASURED (production, 2026-08-05)
--
--   match_results holds 164 distinct team names. `teams` holds 134 for English
--   competitions. Only 89 match exactly — so 46% of the corpus cannot be joined
--   to the feed at all, and the brief is right that this blocks everything.
--
-- AND A SECOND PROBLEM THE BRIEF DID NOT KNOW ABOUT, which is worse because it
-- needs no second source to bite. THE FEED'S OWN `teams` TABLE HOLDS THE SAME
-- CLUB TWICE:
--
--   Birmingham / Birmingham City      Leeds / Leeds United
--   Blackburn / Blackburn Rovers      Leicester / Leicester City
--   Bolton / Bolton Wanderers         Newcastle / Newcastle United
--   Charlton / Charlton Athletic      Norwich / Norwich City
--   Derby / Derby County              Swansea / Swansea City
--   Hull / Hull City                  Tottenham / Tottenham Hotspur
--   Ipswich / Ipswich Town            Wigan / Wigan Athletic
--   QPR / Queens Park Rangers         Wolves / Wolverhampton Wanderers
--   West Brom / West Bromwich Albion
--
--   17 clubs, 134 names. `teams.name` is UNIQUE and planDay upserts on it, so
--   each spelling is a separate row with a separate id and the club's fixtures
--   are split between them. 051's `mx_team_form` partitions by team name, so
--   each of those clubs gets TWO rolling windows instead of one — and the
--   corners and cards models need 20 prior matches per team per venue, so
--   halving a club's history is often the difference between a prediction and
--   silence. This is a live defect in the feed today, independent of the
--   corpus join.
--
-- AFTER MAPPING: 114 of 164 corpus names join the feed (70%, from 54%), and the
-- feed's 134 English names resolve to 117 clubs.
--
-- FULLY AUDITED against BOTH sources, every name, on 2026-08-05 — not the
-- English subset, and not by reasoning about the rules but by enumerating the
-- groups they actually produce:
--
--   1,248 `teams` rows · 222 PLACEHOLDERS excluded · 1,065 distinct clubs
--   57 short names merged · 33 refused as ambiguous
--
-- The 222 placeholders are `team_home_1490361` / `team_away_1490361` — 18% of
-- the table. planDay mints one whenever a fixture arrives without a resolvable
-- team name, and they are the E3 defect already on the engine work order. The
-- job excludes them: each is unique, so aliasing them would mint 222 one-match
-- "clubs", and a fuzzy pass would score team_home_1490361 against
-- team_home_1490362 at 0.94 and merge two unrelated fixtures.
--
-- THREE FALSE MERGES WERE FOUND BY THAT AUDIT, in the matcher's first version.
-- It folded a short name into the one longer name that STARTED with it, which
-- is one candidate too few to be safe:
--
--   AC Ajaccio  →  Ajaccio GFCO      (Gazélec Ajaccio was invisible to the rule:
--                                     the shared token is not at the front)
--   Guinea      →  Guinea-Bissau     (Equatorial Guinea likewise — three countries)
--   Virtus      →  Virtus Entella    (Vicenza Virtus likewise)
--
-- The fix is that merging and refusing use DIFFERENT tests. A short key folds
-- only into a longer key it PREFIXES, and only when no OTHER key CONTAINS its
-- tokens anywhere. Containment alone would have been worse still: `milan`, from
-- "AC Milan", is contained in `intermilan` and nothing else, so it would have
-- folded AC Milan into Inter Milan.
--
-- The 33 refusals include the five prefix ambiguities that exist in the feed:
--
--   Inter          → Inter Club d'Escaldes | Inter Miami | Inter Milan | Inter Turku
--   Austria        → Austria Lustenau | Austria Vienna
--   Celta          → Celta de Vigo II | Celta Vigo
--   Dynamo         → Dynamo Dresden | Dynamo Kyiv
--   Independiente  → Independiente del Valle | Independiente Rivadavia
--
-- `Inter` in this feed means Inter Milan. A matcher that resolved it to
-- whichever candidate sorted first would have attributed Inter Milan's record to
-- Inter Miami, silently, across three continents.
--
-- AND ONE MERGE THAT LOOKS WRONG AND IS NOT. `Wimbledon` and `AFC Wimbledon`
-- stay separate, because Wimbledon FC moved to Milton Keynes in 2004 and AFC
-- Wimbledon is the 2002 fan-founded successor — merging them would credit AFC
-- Wimbledon with a Premier League history it never had. That one is held apart
-- by a curated ALIAS entry, not by a rule.
--
-- WHAT IT REFUSES. `Oxford` is not mapped, because football-data carries both
-- `Oxford City` and (as `Oxford`) Oxford United, and the feed carries
-- `Oxford United`. A short name that could be short for two different clubs is
-- reported as ambiguous and left unresolved until a human adds it to the ALIAS
-- map in lib/teamNames.js. A missed mapping leaves a club short of history and
-- it stays silent, which is correct; a false mapping attributes one club's
-- corners to another and every number downstream inherits it invisibly.

begin;

create table if not exists public.team_alias (
  source        text not null,          -- football_data | live_feed | ...
  raw_name      text not null,
  canonical_key text not null,
  method        text not null default 'exact'   -- exact | prefix | fuzzy | manual
    check (method in ('exact', 'prefix', 'fuzzy', 'manual')),
  updated_at    timestamptz not null default now(),
  primary key (source, raw_name)
);

create index if not exists team_alias_canonical_idx on public.team_alias (canonical_key);

comment on table public.team_alias is
  'One club, one key, across every source. Written ONCE by buildTeamAliases.js '
  'and read by everything else — ensemble/scrapers/names.py implements the same '
  'idea in Python for the research corpus, and rather than keep two matchers '
  'that must agree forever, only this table decides. method=manual marks a row '
  'a human added; the job never overwrites those.';

comment on column public.team_alias.canonical_key is
  'The club. Not a display name — a join key. Resolve display names from `teams`.';

alter table public.team_alias enable row level security;
drop policy if exists team_alias_read on public.team_alias;
create policy team_alias_read on public.team_alias for select using (true);

-- ---------------------------------------------------------------------------
-- The lookup every consumer uses.
--
-- FALLS BACK TO THE NORMALISED NAME, not to NULL, and that is the one place in
-- this work where a fallback is right: an unmapped club still has its own
-- history under its own name, so it keeps working exactly as it does today and
-- simply does not gain the join. Returning NULL would delete a club from the
-- fact table for the crime of being unmapped.
-- ---------------------------------------------------------------------------

create or replace function public.mx_canonical_team(p_source text, p_name text)
returns text language sql stable parallel safe as $$
  select coalesce(
    (select ta.canonical_key
       from public.team_alias ta
      where ta.source = p_source
        and lower(trim(ta.raw_name)) = lower(trim(p_name))
      limit 1),
    lower(trim(p_name))
  );
$$;

comment on function public.mx_canonical_team is
  'Canonical club key for a raw name from a given source. Falls back to the '
  'normalised raw name when unmapped, so an unmapped club keeps its own history '
  'rather than vanishing from the fact table.';

commit;

-- ============================================================================
-- Verification
-- ============================================================================
--
-- The mapping landed:
--   select source, method, count(*) from team_alias group by 1,2 order by 1,2;
--
-- The 17 duplicate clubs are now one club each — this must return 0 rows:
--   select canonical_key, count(*) n, string_agg(raw_name, ' / ')
--     from team_alias where source = 'live_feed'
--    group by 1 having count(*) > 1
--    -- (rows here are EXPECTED: they are the duplicates being collapsed.
--    --  What must NOT appear is two DIFFERENT clubs under one key.)
--
-- Spot-check the refusal — Oxford must be absent or manual, never guessed:
--   select * from team_alias where canonical_key like 'oxford%';
--
-- The join the whole exercise is for. Before mapping this was 89:
--   select count(distinct ta.canonical_key)
--     from team_alias ta
--    where ta.source = 'football_data'
--      and exists (select 1 from team_alias fb
--                   where fb.canonical_key = ta.canonical_key
--                     and fb.source = 'live_feed');
--
-- And then, after 051 is applied and refreshed, the number that matters:
--   select * from public.mx_coverage;
-- ============================================================================
