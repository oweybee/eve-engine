-- 135 — a club can sit in two of one competition's tables
--
-- ── THE FIRST RUN FOUND THIS, AND IT IS A MODELLING ERROR, NOT A FEED BUG ──
--
-- Migration 134 made the key `(league_id, season, api_team_id)`, on the
-- reasoning that "a club can appear in two competitions and in two seasons; it
-- cannot appear twice in one table". True, and the key does not say "one
-- table" — it says one COMPETITION-SEASON, and three of the 48 leagues put the
-- same club in two tables of the same competition-season:
--
--   Veikkausliiga              a regular season, then a championship round
--                              and a relegation round drawn from it
--   Liga Profesional Argentina zone tables plus the overall annual table
--   FIFA World Cup             group tables plus the wider qualifying table
--
-- All three failed their insert on 9 Oct 2026 with
-- `duplicate key value violates unique constraint "league_standings_pkey"`,
-- and because a failed league keeps its previous table, all three stayed
-- empty. 41 of 48 leagues wrote fine; these are the competitions whose shape
-- the key denied.
--
-- Those second tables are REAL and worth keeping: a Finnish club's position in
-- the championship round is the one a reader wants in October, and its regular
-- season position is how it got there. Dropping either would be choosing which
-- of the governing body's tables to believe.
--
-- ── SO THE GROUP JOINS THE KEY, AND STOPS BEING NULLABLE ──────────────────
--
-- A nullable column cannot carry a primary key, so the single-ladder case —
-- most competitions — stores the EMPTY STRING rather than null. `lib/standings`
-- maps '' back to null on the way out, so nothing above this layer learns
-- about the sentinel, and '' sorts first, which puts a competition's main
-- table above its group tables without anyone ordering it.

alter table public.league_standings
  alter column group_label set default '';

update public.league_standings set group_label = '' where group_label is null;

alter table public.league_standings
  alter column group_label set not null;

-- THE KEY, REPLACED. Dropping a primary key takes its index with it, so the
-- table index is rebuilt after.
alter table public.league_standings
  drop constraint league_standings_pkey;

alter table public.league_standings
  add constraint league_standings_pkey
  primary key (league_id, season, group_label, api_team_id);

drop index if exists league_standings_table_idx;
create index if not exists league_standings_table_idx
  on public.league_standings (league_id, season, group_label, position);

comment on column public.league_standings.group_label is
  'The table within the competition. EMPTY STRING for a single ladder, never null, because it is part of the primary key: Veikkausliiga, Liga Profesional Argentina and the World Cup each put the same club in two tables of one competition-season, which the 134 key denied. lib/standings maps '''' back to null.';
