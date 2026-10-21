-- 176: a posting queue for the MaxEdge Facebook Page and Instagram (21 Oct 2026).
--
-- The posting desk used to schedule Facebook and Instagram posts by driving
-- Owen's Chrome, which needs his Mac on and trips platform bot checks. Meta
-- has an official publishing API, so approved posts now go into
-- social_queue and the meta-post edge function publishes each one at its
-- publish_at, using a system-user token held in Edge Function secrets
-- (META_PAGE_TOKEN). X and TikTok are unchanged.
--
-- Nothing here is readable or writable from the browser: RLS is on with no
-- policies and anon/authenticated hold no privileges. Media goes to the
-- public bucket social-media, uploaded only through meta-post with a one-use
-- token that only a database admin can mint (social_upload_token()).
-- The cron job only calls the function when a post is actually due.
--
-- APPLIED 21 Oct 2026: tables via execute_sql; the functions, vault secret,
-- bucket and cron job were pasted by Owen in the SQL Editor (the agent's
-- tooling blocked security-definer DDL). Verified after: all objects exist,
-- anon cannot read the queue or mint upload tokens. meta-post deployed v1.

begin;

create table if not exists public.social_queue (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null check (platform in ('facebook','instagram')),
  media_type   text not null check (media_type in ('image','video','text')),
  media_url    text,
  caption      text not null,
  publish_at   timestamptz not null,
  status       text not null default 'queued'
               check (status in ('queued','publishing','processing','published','failed','cancelled')),
  container_id text,
  post_id      text,
  error        text,
  source       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (media_type = 'text' or media_url is not null),
  check (not (platform = 'instagram' and media_type = 'text'))
);
create index if not exists social_queue_due on public.social_queue (status, publish_at);
alter table public.social_queue enable row level security;
revoke all on public.social_queue from anon, authenticated;

create table if not exists public.social_upload_tokens (
  token      uuid primary key default gen_random_uuid(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
alter table public.social_upload_tokens enable row level security;
revoke all on public.social_upload_tokens from anon, authenticated;

create or replace function public.social_upload_token()
returns uuid language sql security definer set search_path = public as
$$ insert into public.social_upload_tokens default values returning token $$;
revoke execute on function public.social_upload_token() from public, anon, authenticated;

create or replace function public.social_take_upload_token(p uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.social_upload_tokens where token = p and expires_at > now();
  get diagnostics n = row_count;
  delete from public.social_upload_tokens where expires_at <= now();
  return n = 1;
end $$;
revoke execute on function public.social_take_upload_token(uuid) from public, anon, authenticated;
grant execute on function public.social_take_upload_token(uuid) to service_role;

create or replace function public.social_cron_ok(p text)
returns boolean language sql security definer set search_path = public as
$$ select coalesce(p = (select decrypted_secret from vault.decrypted_secrets where name = 'social_cron_secret'), false) $$;
revoke execute on function public.social_cron_ok(text) from public, anon, authenticated;
grant execute on function public.social_cron_ok(text) to service_role;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'social_cron_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'social_cron_secret');
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', true, 104857600, array['image/png','image/jpeg','video/mp4'])
on conflict (id) do nothing;

select cron.schedule('social-publish', '*/5 * * * *', $cron$
  select net.http_post(
    url     := 'https://zlbmpeiuhyllxwegtayu.supabase.co/functions/v1/meta-post?action=run',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'social_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from public.social_queue
                where (status = 'queued' and publish_at <= now()) or status = 'processing');
$cron$);

do $chk$ begin
  if has_table_privilege('anon', 'public.social_queue', 'select')
     or has_table_privilege('authenticated', 'public.social_queue', 'insert') then
    raise exception '176: social_queue is reachable from the client key';
  end if;
  if has_function_privilege('anon', 'public.social_upload_token()', 'execute') then
    raise exception '176: anon can mint upload tokens';
  end if;
end $chk$;

commit;
