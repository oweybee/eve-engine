-- 060_odds_snapshots_current_index.sql
--
-- APPLIED to production 9 Aug 2026 — this file documents changes already
-- live on the database (applied directly so the fix landed without waiting
-- on a deploy; both statements are idempotent/reversible and safe to replay).
--
-- Root cause of a 14-hour odds_snapshots staleness incident (9 Aug 2026):
-- capture_pre_kickoff_odds(), a pg_cron job firing every 5 minutes, ran
--   SELECT DISTINCT ON (match_id, selection) ... FROM odds_snapshots
--   WHERE snapshot_type = 'current' ORDER BY match_id, selection, captured_at DESC
-- against the WHOLE table (712k rows, 247MB) even though its caller only
-- ever needs matches kicking off in the next 2h — 14 matches, 2 pending
-- rows, at the moment this was measured. No index led with snapshot_type in
-- the order this query needed, so the planner walked the whole
-- (match_id, selection, captured_at) index and post-filtered: 298k buffer
-- hits, ~25s per run, every 5 minutes (EXPLAIN ANALYZE BUFFERS, before).
--
-- That was enough contention on the same table captureSnapshot.js writes
-- every ~55s that its bulk prefetch queries started losing to "canceling
-- statement due to statement timeout" (confirmed in postgres logs, repeating
-- in clusters aligned with the cron's :00/:05/:10... firings).
-- captureSnapshot.js throws synchronously on a failed prefetch, and the
-- engine.yml step invokes it as `node captureSnapshot.js 2>/dev/null || true`
-- (workflow fix for that swallowed error is in the same commit as this
-- migration, engine.yml). So every failure was silent: the loop step kept
-- reporting success, ingestOdds.js and computeValues.js kept running, and
-- only odds_snapshots — read by /market-pulse and /api/match-card for price
-- history and CLV — went stale. Discovered by comparing max(captured_at) on
-- odds_snapshots (14h old) against max(fetched_at) on odds (2 min old).
--
-- Two fixes, applied together because the first alone was insufficient:
--
-- 1. A partial index scoped to the rows the query actually reads. This cut
--    the query as originally written from ~25s / 298k buffers to ~2.9s /
--    103k buffers — better, but still slow enough that captureSnapshot.js
--    kept losing the race (confirmed: statement-timeout clusters and a
--    silent captureSnapshot.js failure recurred on the very next cron tick
--    after the index alone was live).
--
-- 2. The real fix: push the 2-hour kickoff window into the subquery instead
--    of filtering AFTER the DISTINCT ON. The function's own final WHERE
--    already restricts to `m.kickoff_at BETWEEN now() AND now() + 2h`, so
--    restricting the "latest snapshot" scan to the same matches first changes
--    nothing about the result — it only stops the function computing the
--    latest snapshot for thousands of matches nobody was going to update.
--    With the partial index from (1) supporting the resulting per-match
--    lookup, this measured at 55ms (EXPLAIN ANALYZE), a ~450x improvement
--    over the original.
--
-- Reversible:
--   DROP INDEX CONCURRENTLY idx_snap_current_match_sel;
--   -- and restore the prior function body (unscoped subquery) from git history.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snap_current_match_sel
  ON public.odds_snapshots (match_id, selection, captured_at DESC)
  WHERE snapshot_type = 'current';

CREATE OR REPLACE FUNCTION public.capture_pre_kickoff_odds()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  UPDATE recommendations r
  SET pre_kickoff_odds = latest.odds
  FROM (
    SELECT DISTINCT ON (os.match_id, os.selection)
      os.match_id,
      os.selection,
      os.odds
    FROM odds_snapshots os
    JOIN matches m ON m.id = os.match_id
    WHERE os.snapshot_type = 'current'
      AND m.kickoff_at BETWEEN now() AND now() + interval '2 hours'
    ORDER BY os.match_id, os.selection, os.captured_at DESC
  ) latest
  JOIN matches m ON m.id = latest.match_id
  WHERE r.match_id     = latest.match_id
    AND r.selection    = latest.selection
    AND r.settled      = false
    AND r.pre_kickoff_odds IS NULL
    AND m.kickoff_at   BETWEEN now() AND now() + interval '2 hours';
END;
$function$;
