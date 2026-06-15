-- ===========================================================================
-- Max Edge — Market tracking: per-bookmaker odds time-series
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
-- ===========================================================================

alter table odds_snapshots add column if not exists market_type text not null default 'h2h';

-- Result grading uses these (already present from 002, kept here for clarity):
alter table recommendations add column if not exists settled boolean default false;
alter table recommendations add column if not exists won     boolean;

create index if not exists idx_snap_series
  on odds_snapshots(match_id, market_type, selection, captured_at);
