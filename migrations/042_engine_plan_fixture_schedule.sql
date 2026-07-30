-- 042: per-fixture tiered polling schedule.
-- engine_plan carried ONE global interval, so every fixture was polled at the
-- same rate — burning quota on games three days out and leaving nothing for the
-- hour before kickoff. lib/pollBudget.js computes a per-fixture tier instead;
-- this column carries it: { "<externalId>": { tier, everyMin, nextPollAt } }.
ALTER TABLE engine_plan ADD COLUMN IF NOT EXISTS fixture_schedule jsonb;
