-- =============================================================================
-- Migration 016: performance_summary singleton key
-- Fixes P0-2: fetchResults.js currently calls .insert() on every run,
-- growing performance_summary unboundedly with duplicate snapshot rows.
-- The root cause is that there is no natural unique key to upsert on.
--
-- This migration adds a synthetic singleton_key column (always = 'current')
-- with a unique constraint. fetchResults.js can then upsert on that key,
-- overwriting the one authoritative performance row instead of appending.
--
-- Existing rows: we consolidate them into one by keeping only the most recent
-- row (by calculated_at) and deleting the rest, then setting singleton_key on
-- the survivor. The DELETE + UPDATE are wrapped in a transaction.
--
-- Safe to re-run (all statements are idempotent via IF NOT EXISTS / DO blocks).
-- =============================================================================

-- Step 1: add the column (nullable first so existing rows don't violate NOT NULL)
alter table performance_summary
  add column if not exists singleton_key text;

-- Step 2: consolidate existing rows — keep only the most recent, delete the rest.
-- Wrapped in a DO block so it's idempotent (no-op if already cleaned up).
do $$
declare
  keeper_id uuid;
begin
  -- Find the most recent row
  select id into keeper_id
  from performance_summary
  order by calculated_at desc
  limit 1;

  if keeper_id is not null then
    -- Delete all other rows
    delete from performance_summary where id <> keeper_id;

    -- Mark the surviving row as the singleton
    update performance_summary
    set singleton_key = 'current'
    where id = keeper_id;
  end if;
end $$;

-- Step 3: set default so future inserts/upserts don't need to specify the column
alter table performance_summary
  alter column singleton_key set default 'current';

-- Step 4: add the unique constraint (safe: only one row exists after Step 2)
-- Using DO block so it's idempotent if already present
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'performance_summary_singleton_key_unique'
      and conrelid = 'performance_summary'::regclass
  ) then
    alter table performance_summary
      add constraint performance_summary_singleton_key_unique
      unique (singleton_key);
  end if;
end $$;

comment on column performance_summary.singleton_key is
  'Always ''current''. Unique constraint enables upsert — keeps exactly one authoritative row.';
