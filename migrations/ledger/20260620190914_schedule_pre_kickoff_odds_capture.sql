-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620190914, name schedule_pre_kickoff_odds_capture. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Function: snapshot pre-kickoff odds for recommendations about to kick off
-- Runs every 30 minutes and captures the latest available odds for any
-- recommendation where the match kicks off within the next 2 hours.
CREATE OR REPLACE FUNCTION capture_pre_kickoff_odds()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE recommendations r
  SET pre_kickoff_odds = latest.odds
  FROM (
    SELECT DISTINCT ON (os.match_id, os.selection)
      os.match_id,
      os.selection,
      os.odds
    FROM odds_snapshots os
    WHERE os.snapshot_type = 'current'
    ORDER BY os.match_id, os.selection, os.captured_at DESC
  ) latest
  JOIN matches m ON m.id = latest.match_id
  WHERE r.match_id     = latest.match_id
    AND r.selection    = latest.selection
    AND r.settled      = false
    AND r.pre_kickoff_odds IS NULL
    AND m.kickoff_at   BETWEEN now() AND now() + interval '2 hours';
END;
$$;

-- Schedule: every 30 minutes
SELECT cron.schedule(
  'capture-pre-kickoff-odds',
  '*/30 * * * *',
  $$ SELECT capture_pre_kickoff_odds(); $$
);

