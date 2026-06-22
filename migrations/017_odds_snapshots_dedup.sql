-- =============================================================================
-- Migration 017: odds_snapshots dedup constraint
-- Fixes P0-5: captureSnapshot.js calls .insert() with no conflict guard.
-- On crash + restart, depthRows are duplicated. Market-depth charts double
-- their data silently because odds_snapshots has no unique constraint.
--
-- The natural dedup key for a snapshot is:
--   (match_id, bookmaker, selection, market_type, DATE_TRUNC('hour', captured_at))
--
-- Truncating to the hour means one canonical snapshot row per bookmaker per
-- outcome per hour per match. Within a 15-minute cron window, the upsert
-- will overwrite rather than append — the latest price wins.
--
-- Existing duplicates: we clean them up before adding the constraint by
-- deleting all but the most recently captured row per natural key group.
--
-- Safe to re-run (idempotent via DO blocks and IF NOT EXISTS).
-- =============================================================================

-- Step 1: add the bucketed-hour column used as the constraint key.
-- Stored as a generated column so it is always in sync with captured_at.
alter table odds_snapshots
  add column if not exists captured_hour timestamptz
  generated always as (date_trunc('hour', captured_at)) stored;

-- Step 2: remove duplicate rows, keeping only the latest per natural key.
-- The CTE identifies the loser rows; the DELETE removes them.
do $$
begin
  -- Only run if there are actually duplicates to avoid a no-op table scan
  if exists (
    select 1 from odds_snapshots
    group by match_id, bookmaker, selection, market_type, date_trunc('hour', captured_at)
    having count(*) > 1
    limit 1
  ) then
    delete from odds_snapshots
    where id in (
      select id from (
        select
          id,
          row_number() over (
            partition by match_id, bookmaker, selection, market_type, date_trunc('hour', captured_at)
            order by captured_at desc    -- keep the most recent
          ) as rn
        from odds_snapshots
      ) ranked
      where rn > 1
    );
  end if;
end $$;

-- Step 3: add the unique constraint that captureSnapshot.js will use as its
-- onConflict target. After Step 2, no duplicates exist so this will not fail.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'odds_snapshots_dedup_key'
      and conrelid = 'odds_snapshots'::regclass
  ) then
    alter table odds_snapshots
      add constraint odds_snapshots_dedup_key
      unique (match_id, bookmaker, selection, market_type, captured_hour);
  end if;
end $$;

-- Step 4: a supporting index for the constraint (Postgres creates one automatically
-- for unique constraints, but we document it explicitly for clarity).
-- The existing idx_snap_series covers read patterns; the unique constraint
-- index covers the write dedup path.

comment on column odds_snapshots.captured_hour is
  'DATE_TRUNC(''hour'', captured_at). Part of the dedup key — one row per bookmaker/selection/hour.';
comment on constraint odds_snapshots_dedup_key on odds_snapshots is
  'Prevents duplicate snapshots within the same hour. Used as onConflict target in captureSnapshot.js.';
