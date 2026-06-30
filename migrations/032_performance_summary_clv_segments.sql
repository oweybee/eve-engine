-- 032_performance_summary_clv_segments.sql
--
-- Segmented CLV reporting. A single blended avg_clv can be dragged down by thin
-- (<5pp) or anomalously-wide (>25pp) edges that aren't the signals the engine
-- actually alerts on, so the headline figure is misleading on its own. We keep
-- avg_clv (all settled) and add a sweet-spot (5-25pp) variant, plus the no-vig
-- counterparts and sample sizes so the dashboard can show how thin each figure
-- is. Sweet-spot membership is derived from detected_edge at report time, so it
-- is independent of the stored value_signals.signal_category label.
--
-- avg_no_vig_clv already exists; fetchResults.js now computes it from the
-- de-vigged Betfair close. This migration only adds the new columns.
--
-- (Originally authored as 030; renumbered to 032 — 030/031 were taken by the
-- in-play-phase and team-elo migrations on main.)
--
-- Safe/additive: all columns nullable, no backfill required — the next
-- fetchResults run repopulates the singleton performance_summary rows.

ALTER TABLE performance_summary
  ADD COLUMN IF NOT EXISTS avg_clv_sweetspot        numeric,
  ADD COLUMN IF NOT EXISTS avg_no_vig_clv_sweetspot numeric,
  ADD COLUMN IF NOT EXISTS clv_sample               integer,
  ADD COLUMN IF NOT EXISTS clv_sweetspot_sample     integer;
