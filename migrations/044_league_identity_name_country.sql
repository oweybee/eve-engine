-- 044: league identity is (name, country), not name alone.
--
-- `leagues` was UNIQUE (name), so distinct competitions sharing a name merged
-- into one row, with each upsert overwriting the country (last writer wins).
-- The expanded tracked set (migration-era trackedLeagues.js) collides five
-- ways: Premier League (England / Russia), Serie A (Italy / Brazil),
-- Championship (England / Scotland), Bundesliga (Germany / Austria) and
-- Super League (Greece / Switzerland / China) — the season backfill filed
-- England's Premier League fixtures under a league row stamped "Russia".
--
-- The UPDATEs restore each merged row to the country that first owned it (the
-- historical corpus for PL/Serie A; first-tracked order otherwise); on a fresh
-- database they are no-ops. Re-running the season backfill afterwards creates
-- proper rows for the other countries and re-points their matches (bulk upsert
-- on external_id rewrites league_id).
--
-- Every league upsert in the engine must now target ON CONFLICT (name, country)
-- — planDay.js, ingestOdds.js, betfairIngest.js — since the name-only
-- constraint no longer exists to conflict on.
ALTER TABLE leagues DROP CONSTRAINT leagues_name_key;

UPDATE leagues SET country = 'England' WHERE name = 'Premier League';
UPDATE leagues SET country = 'Italy'   WHERE name = 'Serie A';
UPDATE leagues SET country = 'Germany' WHERE name = 'Bundesliga';
UPDATE leagues SET country = 'England' WHERE name = 'Championship';
UPDATE leagues SET country = 'Greece'  WHERE name = 'Super League';

ALTER TABLE leagues ADD CONSTRAINT leagues_name_country_key UNIQUE (name, country);
