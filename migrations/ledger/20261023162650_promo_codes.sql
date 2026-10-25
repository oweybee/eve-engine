-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261023162650, name promo_codes. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create table if not exists public.promo_codes (
  code            text primary key check (code ~ '^[A-Z0-9]{4,20}$'),
  label           text not null,
  trial_days      integer not null check (trial_days between 1 and 365),
  max_redemptions integer not null check (max_redemptions > 0),
  active          boolean not null default false,
  starts_at       timestamptz,
  ends_at         timestamptz,
  created_at      timestamptz not null default now()
);
create table if not exists public.promo_redemptions (
  id                  bigserial primary key,
  code                text not null references public.promo_codes(code),
  checkout_session_id text not null unique,
  user_id             uuid references auth.users(id) on delete set null,
  status              text not null default 'pending' check (status in ('pending','completed','expired')),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);
create index if not exists promo_redemptions_code_status on public.promo_redemptions (code, status);
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
revoke all on public.promo_codes, public.promo_redemptions from anon, authenticated;
revoke all on sequence public.promo_redemptions_id_seq from anon, authenticated;
create or replace function public.promo_places_taken(p_code text)
returns integer language sql stable security invoker set search_path = public as $$
  select count(*)::int from public.promo_redemptions
  where code = p_code
    and (status = 'completed' or (status = 'pending' and created_at > now() - interval '35 minutes'))
$$;
revoke all on function public.promo_places_taken(text) from public, anon, authenticated;
insert into public.promo_codes (code, label, trial_days, max_redemptions, active)
values ('MAX100', '100 days of Plus for the first 100', 100, 100, false)
on conflict (code) do nothing;
