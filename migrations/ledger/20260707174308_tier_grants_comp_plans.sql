-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260707174308, name tier_grants_comp_plans. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- ── tier_grants: operator-managed comp/manual plan grants keyed by email ─────
-- Grants a paid tier to an email before (or without) any Stripe subscription.
-- The signup trigger honours it so the grant applies the moment that email
-- registers; existing profiles are reconciled immediately below.
create table if not exists public.tier_grants (
  email      text primary key,
  tier       text not null check (tier in ('free','starter','edge','pro')),
  note       text,
  created_at timestamptz not null default now()
);
alter table public.tier_grants enable row level security;
drop policy if exists tier_grants_service on public.tier_grants;
create policy tier_grants_service on public.tier_grants for all to service_role using (true) with check (true);

-- Signup provisioning now seeds the granted tier (defaulting to 'free').
create or replace function public.handle_new_portal_user()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_tier text;
begin
  select tier into v_tier from public.tier_grants where email = lower(new.email);
  insert into public.profiles (id, email, tier)
    values (new.id, new.email, coalesce(v_tier, 'free'))
    on conflict (id) do nothing;
  insert into public.preferences (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end; $$;
revoke execute on function public.handle_new_portal_user() from public, anon, authenticated;

-- Reconcile any already-registered profile whose email carries a grant.
update public.profiles p set tier = g.tier
from public.tier_grants g
where lower(p.email) = g.email and p.tier is distinct from g.tier;
