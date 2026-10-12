-- 145 - the Discord clock lives in pg_cron too
--
-- ── WHAT WAS FOUND ON 12 OCT 2026 ────────────────────────────────────────────
--
-- #hit-rates had never received a scheduled trends card. post-to-discord.yml
-- asked GitHub for ~120 scheduled runs a day; GitHub delivered 32 between
-- 9 Oct 19:33 and 12 Oct 08:04 UTC, and NOT ONE of them was the daily
-- '5 7 * * *' trends tick, the Monday '13 8 * * 1' record tick or the Monday
-- '27 8 * * 1' edge tick. Every delivered run read its schedule string, did
-- not match a digest, and fell through to signals or results. Nothing failed,
-- so nothing alerted. engine.yml hit the same wall (1 of 59 runs on 9 Oct)
-- and moved to pg_cron in migration 136; this is the same move.
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────
--
--   1. A vault secret `discord_cron_secret` (created here if absent, random).
--   2. check_discord_cron_secret(text) - SECURITY DEFINER, service_role only,
--      so the edge function can verify the caller without holding the value.
--   3. One pg_cron job per mode, each posting {mode} to the trigger-discord
--      edge function with the secret header read from the vault at run time.
--
-- The `schedule:` block is removed from post-to-discord.yml in the same commit.
-- The digests have no dedupe, so two clocks would double-post.
--
-- To change a cadence, write a new migration that alters these jobs.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'discord_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                'discord_cron_secret',
                                'x-cron-secret for the trigger-discord edge function');
  end if;
end $$;

create or replace function public.check_discord_cron_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select decrypted_secret = p_secret
       from vault.decrypted_secrets
      where name = 'discord_cron_secret'
      limit 1),
    false)
$$;

revoke all on function public.check_discord_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_discord_cron_secret(text) to service_role;

do $$
declare
  j record;
begin
  for j in
    select * from (values
      ('discord-signals', '7,22,37,52 * * * *', 'signals'),
      ('discord-results', '41 * * * *',         'results'),
      ('discord-trends',  '5 7 * * *',          'trends'),
      ('discord-movers',  '35 9,12,17 * * *',   'movers'),
      ('discord-weekly',  '13 8 * * 1',         'weekly'),
      ('discord-edge',    '27 8 * * 2',         'edge')
    ) as t(name, sched, mode)
  loop
    perform cron.schedule(j.name, j.sched, format($c$
      select net.http_post(
        url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/trigger-discord',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                             where name = 'discord_cron_secret' limit 1)),
        body    := jsonb_build_object('mode', %L))
    $c$, j.mode));
  end loop;
end $$;
