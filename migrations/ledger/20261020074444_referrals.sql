-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261020074444, name referrals. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create table if not exists public.referral_codes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  code       text not null unique check (code ~ '^[A-Z0-9]{6,12}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id                      bigserial primary key,
  referrer_user_id        uuid not null references auth.users(id) on delete cascade,
  code                    text not null,
  stripe_subscription_id  text not null unique,
  stripe_customer_id      text,
  referred_user_id        uuid references auth.users(id) on delete set null,
  referred_email          text,
  status                  text not null default 'pending'
                          check (status in ('pending', 'rewarded', 'void')),
  void_reason             text,
  credit_pence            integer,
  stripe_balance_txn_id   text,
  created_at              timestamptz not null default now(),
  rewarded_at             timestamptz
);

create index if not exists referrals_referrer_idx on public.referrals (referrer_user_id, created_at desc);

alter table public.referral_codes enable row level security;
alter table public.referrals      enable row level security;

revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referrals      from anon, authenticated;
revoke all on sequence public.referrals_id_seq from anon, authenticated;
