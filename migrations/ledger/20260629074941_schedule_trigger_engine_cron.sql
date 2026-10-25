-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260629074941, name schedule_trigger_engine_cron. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- A JWT in this file was replaced with <REDACTED_JWT> (public repo).
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Idempotent: unschedule if exists, then re-create
DO $$
BEGIN
  PERFORM cron.unschedule('trigger-engine-every-5min');
EXCEPTION WHEN OTHERS THEN
  NULL; -- job didn't exist yet
END;
$$;

SELECT cron.schedule(
  'trigger-engine-every-5min',
  '*/5 * * * *',
  $$SELECT net.http_post(
    url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/trigger-engine',
    headers := '{"Authorization": "Bearer <REDACTED_JWT>", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )$$
);

