-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260708150306, name reverse_trial_30d_edge. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Reverse trial: new/free users get 30 days of full Edge access, then Free.
-- The whole paywall keys off current_tier(); making it trial-aware unlocks
-- everything server-side. Expiry is automatic via profiles.trial_ends_at.

alter table public.profiles add column if not exists trial_ends_at timestamptz;

-- Trial-aware effective tier: a live trial lifts a *free* user to 'edge'.
create or replace function public.current_tier()
returns text language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce((
    select case
      when p.trial_ends_at is not null and p.trial_ends_at > now()
           and coalesce(p.tier, 'free') = 'free'
        then 'edge'
      else coalesce(p.tier, 'free')
    end
    from public.profiles p
    where p.id = auth.uid()
  ), 'free');
$$;
revoke execute on function public.current_tier() from public, anon;
grant  execute on function public.current_tier() to authenticated;

-- Signup provisioning: preserve the tier_grants email->tier pre-grant, and give
-- a 30-day trial to anyone who isn't pre-granted a paid tier.
create or replace function public.handle_new_portal_user()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_tier text;
begin
  select tier into v_tier from public.tier_grants where email = lower(new.email);
  insert into public.profiles (id, email, tier, trial_ends_at)
    values (new.id, new.email, coalesce(v_tier, 'free'),
            case when coalesce(v_tier, 'free') = 'free' then now() + interval '30 days' else null end)
    on conflict (id) do nothing;
  insert into public.preferences (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end; $$;
revoke execute on function public.handle_new_portal_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_portal on auth.users;
create trigger on_auth_user_created_portal after insert on auth.users
  for each row execute function public.handle_new_portal_user();

-- The free bet cap reads profiles directly, so bake the same trial logic in.
create or replace function public.enforce_free_bet_cap()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_tier  text;
  v_count integer;
  v_cap   constant integer := 50;   -- keep in sync with FREE_MAX_BETS in lib/portal/tiers.js
begin
  select case
    when p.trial_ends_at is not null and p.trial_ends_at > now()
         and coalesce(p.tier, 'free') = 'free'
      then 'edge'
    else coalesce(p.tier, 'free')
  end
  into v_tier
  from public.profiles p where p.id = new.user_id;
  if coalesce(v_tier, 'free') = 'free' then
    select count(*) into v_count from public.bets where user_id = new.user_id;
    if v_count >= v_cap then
      raise exception 'Free plan bet limit reached (% bets). Upgrade to keep your full record.', v_cap
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end; $$;
revoke execute on function public.enforce_free_bet_cap() from public, anon, authenticated;
drop trigger if exists trg_enforce_free_bet_cap on public.bets;
create trigger trg_enforce_free_bet_cap before insert on public.bets
  for each row execute function public.enforce_free_bet_cap();

-- One-time re-engagement: grant existing Free users a fresh 30-day trial.
update public.profiles
  set trial_ends_at = now() + interval '30 days'
  where trial_ends_at is null and coalesce(tier, 'free') = 'free';
