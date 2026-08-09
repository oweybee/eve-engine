-- 060_odds_snapshots_current_index.sql
--
-- APPLIED to production 9 Aug 2026 — this file documents a change already
-- live on the database (CREATE INDEX CONCURRENTLY, applied out-of-band so it
-- would not hold a lock across the live ingest loop).
--
-- Root cause of a 14-hour odds_snapshots staleness incident (9 Aug 2026):
-- capture_pre_kickoff_odds(), a pg_cron job firing every 5 minutes, runs
--   SELECT DISTINCT ON (match_id, selection) ... FROM odds_snapshots
--   WHERE snapshot_type = 'current' ORDER BY match_id, selection, captured_at DESC
-- against a table that had grown to 712k rows (247MB). No index led with
-- snapshot_type in the order this query needs, so the planner walked the
-- whole (match_id, selection, captured_at) index and post-filtered — 298k
-- buffer hits, ~25s per run, every 5 minutes. That was enough contention on
-- the same table captureSnapshot.js writes every ~55s that its bulk prefetch
-- queries started losing to "canceling statement due to statement timeout".
--
-- captureSnapshot.js throws synchronously on a failed prefetch, and the
-- engine.yml step invokes it as `node captureSnapshot.js 2>/dev/null || true`
-- (see 061_no relation — the workflow fix is in the same commit as this
-- migration). So every failure was silent: the loop step still reported
-- "success", ingestOdds.js and computeValues.js kept running, and only
-- odds_snapshots — read by /market-pulse and /api/match-card for price
-- history and CLV — went stale. Discovered by comparing max(captured_at) on
-- odds_snapshots (14h old) against max(fetched_at) on odds (2 min old).
--
-- Fix: a partial index scoped to the rows this query actually reads. It cut
-- the query from ~25s / 298k buffers to ~2.9s / 103k buffers, measured with
-- EXPLAIN (ANALYZE, BUFFERS) before and after on production.
--
-- Reversible: DROP INDEX CONCURRENTLY idx_snap_current_match_sel;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snap_current_match_sel
  ON public.odds_snapshots (match_id, selection, captured_at DESC)
  WHERE snapshot_type = 'current';
