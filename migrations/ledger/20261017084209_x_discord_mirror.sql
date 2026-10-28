-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261017084209, name x_discord_mirror. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Mirror the MaxEdge X account's own posts into a Discord channel.
create table if not exists public.x_mirror_state (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  x_user_id text,
  since_id text,
  last_run timestamptz,
  last_error text
);
insert into public.x_mirror_state (id) values (1) on conflict do nothing;

create table if not exists public.x_mirror_posts (
  tweet_id text primary key,
  tweet_created_at timestamptz,
  discord_message_id text,
  posted_at timestamptz not null default now()
);

alter table public.x_mirror_state enable row level security;
alter table public.x_mirror_posts enable row level security;

-- Webhook lives in the vault as x_mirror_discord_webhook. Service role only.
create or replace function public.x_mirror_webhook()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'x_mirror_discord_webhook' limit 1
$$;
revoke all on function public.x_mirror_webhook() from public, anon, authenticated;
grant execute on function public.x_mirror_webhook() to service_role;

select cron.schedule('x-mirror', '*/5 * * * *', $cron$
  select net.http_post(
    url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/x-discord-mirror',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'discord_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000)
$cron$);
