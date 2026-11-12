-- 197: the lineup-dms clock. Every 2 minutes; capture-lineups writes every 4,
-- so a confirmed XI waits at most ~2 minutes for its DM. The function only
-- does work when lineup_dms_due returns rows, so idle runs are one cheap query.
select cron.unschedule('lineup-dms') where exists (select 1 from cron.job where jobname = 'lineup-dms');
select cron.schedule('lineup-dms', '*/2 * * * *', $cron$
  select net.http_post(
    url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/lineup-dms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                         where name = 'discord_cron_secret' limit 1)),
    body    := jsonb_build_object('action', 'tick'),
    timeout_milliseconds := 150000)
$cron$);
