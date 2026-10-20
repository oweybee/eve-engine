-- 169: the daily player hit-rate card to #hit-rates, 07:20 UTC, fifteen
-- minutes after the team trends card. Same clock as every other Discord mode:
-- pg_cron -> trigger-discord -> post-to-discord.yml (mode=players).
select cron.unschedule('discord-players') where exists (select 1 from cron.job where jobname = 'discord-players');
select cron.schedule('discord-players', '20 7 * * *', $cmd$
      select net.http_post(
        url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/trigger-discord',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                             where name = 'discord_cron_secret' limit 1)),
        body    := jsonb_build_object('mode', 'players'))
    $cmd$);
