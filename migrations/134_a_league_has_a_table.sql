-- 134 — a league has a table, and the table is a public fact
--
-- ── WHY THERE WASN'T ONE (and why the refusal was right until now) ─────────
--
-- `/competitions/[slug]` has carried this comment since it was written: "A TEAM
-- STANDINGS TABLE. There is no standings source: no `standings` table, no view,
-- nothing in the schema. Deriving a league table from `matches` in the browser
-- would put a third copy of a computation in the product."
--
-- That was the correct call twice over. A table derived in the browser would be
-- wrong in ways nobody could see: points deductions, expunged records,
-- play-off groupings and mid-season reorganisations are all decisions a
-- governing body makes and none of them is in `matches`. Deriving it would have
-- produced a table that looked authoritative and disagreed with the official
-- one, which is worse than having none.
--
-- Owner, 9 Oct: "lets get league tables in, add to the competitions page and as
-- a tab on the details page". So the table comes from the vendor who has the
-- governing body's own version, one call per league-season, and is STORED
-- rather than computed. `fetchStandings.js` writes it.
--
-- ── IT IS OPEN TO EVERYONE, DELIBERATELY ───────────────────────────────────
--
-- A league table is a published fact about a football competition. It is not
-- our read, not a price and not a signal, so there is nothing here to gate and
-- gating it would be gating the newspaper. `/competitions` and `/leagues` are
-- already fully open at every tier for the same reason, and the fixture card's
-- "10th v 2nd" line needs this on the anonymous board.
--
-- ── AND IT CARRIES THE VENDOR'S NAMES AS WELL AS OUR IDS ───────────────────
--
-- MEASURED 9 OCT 2026: 781 of 1,561 rows in `teams` have an `external_id`. So a
-- standings row keyed only on `team_id` would silently drop half the clubs in
-- the country, and a league table missing half its rows is worse than no league
-- table — it is a table a reader would believe.
--
-- `team_name` and `api_team_id` are therefore NOT NULL and `team_id` is
-- nullable. The table renders whole from the vendor's own names; the join is
-- what lets a fixture card say "10th v 2nd", and it fills in as the alias work
-- resolves more clubs. A null `team_id` costs a position line on one card. A
-- missing row costs the table's credibility.

create table if not exists public.league_standings (
  league_id     uuid        not null references public.leagues(id) on delete cascade,
  season        int         not null,
  -- The vendor's own id for the club. THE KEY, because it is the only
  -- identifier present on every row.
  api_team_id   int         not null,
  -- Our club, where we have resolved it. Nullable; see above.
  team_id       uuid        references public.teams(id) on delete set null,
  team_name     text        not null,
  crest_url     text,

  -- THE GROUP, because not every competition is one ladder. A league phase
  -- with four groups returns four tables from the same call and they are not
  -- comparable; "3rd" means nothing without saying 3rd of what. Null for a
  -- single-table competition, which is most of them.
  group_label   text,
  -- The vendor's own rank inside that group. NOT derived from points here:
  -- deductions and tie-break rules are the governing body's and arriving at
  -- the same order by sorting would be the browser-derived table again.
  position      int         not null,

  played        int         not null default 0,
  won           int         not null default 0,
  drawn         int         not null default 0,
  lost          int         not null default 0,
  goals_for     int         not null default 0,
  goals_against int         not null default 0,
  points        int         not null default 0,
  -- "WWDLW", oldest first, as the vendor gives it. Null where it does not.
  form          text,

  updated_at    timestamptz not null default now(),

  -- ONE ROW PER CLUB PER LEAGUE-SEASON. A club can appear in two
  -- competitions and in two seasons; it cannot appear twice in one table.
  primary key (league_id, season, api_team_id)
);

-- THE TWO READS THIS TABLE EXISTS FOR.
-- A whole table for a competition page, and one club's row for a fixture card.
create index if not exists league_standings_table_idx
  on public.league_standings (league_id, season, group_label, position);
create index if not exists league_standings_team_idx
  on public.league_standings (team_id, season) where team_id is not null;

alter table public.league_standings enable row level security;

-- READ BY EVERYONE, INCLUDING ANON. See the note above: this is a published
-- fact about a football competition, not a read of ours.
drop policy if exists league_standings_read on public.league_standings;
create policy league_standings_read on public.league_standings
  for select using (true);

-- WRITTEN BY THE ENGINE ONLY. The service role bypasses RLS, so there is
-- deliberately no insert or update policy: no browser session, authenticated
-- or not, can write a league table.

grant select on public.league_standings to anon, authenticated;

-- AND THE REVOKE IS NOT BELT-AND-BRACES, it is the house convention, checked.
-- This schema's default privileges grant the browser roles everything on a new
-- table, so `grant select` alone left `has_table_privilege('anon', …,
-- 'insert')` TRUE on first apply — measured 9 Oct — while every comparable
-- table (leagues, teams, matches, odds, computed_values, elo_forecasts,
-- value_signals) reads FALSE. RLS with no insert policy does block the write,
-- so nothing was reachable; the point is that a table should not be the one
-- exception whose safety rests on a second mechanism.
revoke insert, update, delete, truncate, references, trigger
  on public.league_standings from anon, authenticated;

comment on table public.league_standings is
  'The governing body''s own league table per league-season, as API-Football serves it. STORED, never derived: points deductions and tie-break rules are not in `matches`. Written by fetchStandings.js under the service role; readable by everyone because a league table is a published fact.';
comment on column public.league_standings.team_id is
  'Our club, where resolved. NULLABLE because only 781 of 1,561 teams carry an external_id (9 Oct 2026) and a table missing half its rows would be worse than none. The table renders from team_name; this column is what lets a fixture card say "10th v 2nd".';
comment on column public.league_standings.position is
  'The VENDOR''S rank within group_label. Never re-derived by sorting on points: deductions and tie-breaks are the governing body''s.';
