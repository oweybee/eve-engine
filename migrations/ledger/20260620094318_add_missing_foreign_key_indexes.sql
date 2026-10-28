-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620094318, name add_missing_foreign_key_indexes. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Add covering indexes for unindexed foreign keys flagged by the performance advisor.
CREATE INDEX IF NOT EXISTS idx_head_to_head_home_team_id  ON public.head_to_head  (home_team_id);
CREATE INDEX IF NOT EXISTS idx_head_to_head_away_team_id  ON public.head_to_head  (away_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_home_team_id        ON public.matches        (home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team_id        ON public.matches        (away_team_id);
CREATE INDEX IF NOT EXISTS idx_recent_form_team_id         ON public.recent_form    (team_id);
CREATE INDEX IF NOT EXISTS idx_recent_form_opponent_id     ON public.recent_form    (opponent_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_match_id          ON public.watchlist      (match_id);

