-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625165504, name 026_engine_plan_api_call_tracking. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Track total API calls made today across all engine scripts
-- ingestOdds calls are derivable (runs_completed × array_length(fixture_ids, 1))
-- fetchMatchDetails calls are incremented directly by the script
alter table public.engine_plan
  add column if not exists details_calls_used integer not null default 0;

comment on column public.engine_plan.details_calls_used is
  'API calls made by fetchMatchDetails.js today. Incremented after each run.';

