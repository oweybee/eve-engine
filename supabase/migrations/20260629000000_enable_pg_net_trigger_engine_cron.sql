-- Enable pg_net for async HTTP calls from the database
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Trigger the EVE engine every 5 minutes via the trigger-engine Edge Function.
-- The Edge Function calls GitHub workflow_dispatch (engine.yml, main branch).
-- This replaces reliance on the GitHub Actions `*/5 * * * *` cron, which is
-- throttled to ~hourly on shared runners.
--
-- Required: GITHUB_PAT secret must be set in Supabase Edge Function secrets
-- (Supabase dashboard → Edge Functions → trigger-engine → Secrets).
DELETE FROM cron.job WHERE jobname = 'trigger-engine-every-5min';

SELECT cron.schedule(
  'trigger-engine-every-5min',
  '*/5 * * * *',
  $$SELECT net.http_post(
    url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/trigger-engine',
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsYm1wZWl1aHlsbHh3ZWd0YXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyMTExNzMsImV4cCI6MjA5Njc4NzE3M30.dGEiyEWgVxmh8Q7U9NlnnqUsAnMQy32DLNc1IA5KjYI", "Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )$$
);
