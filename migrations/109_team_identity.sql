-- 109_team_identity.sql — give a team the provider's own id, so a crest can be
-- fetched for it and a future join has a key that is not a spelling.
--
-- APPLIED AND VERIFIED IN PRODUCTION, 26 Aug 2026. Column present, index is
-- `CREATE UNIQUE INDEX ... WHERE (external_id IS NOT NULL)`, and all 1,561
-- existing rows are untouched (0 ids set — the backfill writes those).
--
-- WHAT WAS TRUE BEFORE THIS. `teams` holds 1,561 rows and `crest_url` is
-- populated on ZERO of them, measured 26 Aug 2026. The column has existed all
-- along; nothing has ever written it. The provider we already pay for —
-- API-Football — returns `{ id, name, logo, winner }` on every team object of
-- every fixture, and `planDay.js` iterated the NAMES out of that object and
-- discarded the rest. So the id and the crest have been arriving on every
-- ingest since the pipeline was built and being thrown away at the door.
--
-- `crest_url` IS NOT RE-ADDED HERE. It exists. Only `external_id` is new.
--
-- ── WHY THE INDEX IS UNIQUE, AND WHAT THAT COSTS ──────────────────────────
--
-- `lib/teamNames.js` documents that each SPELLING is its own row by design, and
-- `planDay.js` upserts teams `onConflict: 'name'` for that reason. So a club can
-- legitimately hold several rows — "Bayern Munich" from football-data.co.uk and
-- "Bayern München" from API-Football — and both of them resolve, through the
-- alias table, to the same API-Football id.
--
-- That makes a unique `external_id` a REAL constraint and not a formality: the
-- second spelling to claim an id is rejected with 23505. It is still the right
-- shape, because the two columns are answering different questions:
--
--     external_id   the CANONICAL row for this club. One row per provider id,
--                   which is what makes it usable as a join key at all.
--     crest_url     a picture of the club. Every spelling may carry it, and
--                   they all carry the same one.
--
-- So a spelling that loses the race for `external_id` still gets its crest, and
-- the board draws correctly for it. Both writers are built for that outcome
-- rather than surprised by it: `planDay.js` falls back to a crest-only upsert
-- for a chunk that hits 23505 (ingestion must never fail over a decoration),
-- and `backfillTeamCrests.js` claims the id for one row per club and writes the
-- crest to all of them.
--
-- Reversible: drop index teams_external_id_key; alter table teams drop column
-- external_id;

alter table teams add column if not exists external_id text;

comment on column teams.external_id is
  'API-Football team id, as text. UNIQUE where present: one row per provider id, '
  'so the several spellings of one club share a crest but only the canonical row '
  'carries the key. See migrations/109_team_identity.sql.';

-- Partial, so the 1,561 rows that have no id yet do not all collide on NULL.
-- (A plain unique index would permit them — NULLs are distinct — but stating
-- the predicate says the intent out loud and keeps the index small.)
create unique index if not exists teams_external_id_key
  on teams (external_id) where external_id is not null;
