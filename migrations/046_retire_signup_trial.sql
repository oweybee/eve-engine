-- 046_retire_signup_trial.sql
--
-- APPLIED to production 2026-08-02, verified live in rolled-back transactions:
--   • a new auth.users row      → profile tier 'free', trial_ends_at null
--   • a new user with a comp    → profile tier 'plus', trial_ends_at null
--
-- The product ran TWO trials. handle_new_portal_user() gave every new signup
-- 30 days of full Plus access at the database — no card, no Stripe, invisible
-- to billing — by setting profiles.trial_ends_at, which current_tier() turns
-- into 'edge' (a paid tier) while it is in the future. Separately a 7-day trial
-- was created in the Stripe product catalogue. Left as-is a new user would get
-- 30 days free, be asked for a card, and then be given 7 more.
--
-- DECISION (2 Aug 2026): keep the 7-day card-required trial, drop the 30-day
-- one. A trial that collects a card converts; 30 days of anonymous full access
-- is the product's entire value given away with nothing to convert against.
--
-- The 7-day trial is granted in the Checkout session (lib/stripe.js TRIAL_DAYS,
-- applied by app/api/checkout/route.js), not by the Stripe catalogue entry —
-- a session built from a bare price does not pick that up. A trialling user is
-- a real Stripe subscriber with status 'trialing', which isActiveStatus()
-- already treats as granting Plus, so no gating change is needed here.
--
-- THIS MIGRATION ONLY STOPS NEW GRANTS. It deliberately does not touch existing
-- rows; see the note at the foot for the accounts already mid-trial.
--
-- current_tier()'s trial branch is left in place ON PURPOSE. With no automatic
-- writer it becomes a manual comp lever — set trial_ends_at on a profile to
-- hand someone time-boxed access — and migration 045 made that column
-- server-writable only, so it is now a safe one. tier_grants remains the way to
-- comp open-ended access.

begin;

create or replace function public.handle_new_portal_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare v_tier text;
begin
  select tier into v_tier from public.tier_grants where email = lower(new.email);
  -- trial_ends_at is no longer granted at signup: the trial is card-required
  -- and runs in Stripe. A comped tier from tier_grants still applies.
  insert into public.profiles (id, email, tier, trial_ends_at)
    values (new.id, new.email, coalesce(v_tier, 'free'), null)
    on conflict (id) do nothing;
  insert into public.preferences (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end; $function$;

commit;

-- ── Accounts already mid-trial ───────────────────────────────────────────────
-- At the time of writing 10 profiles hold a future trial_ends_at, granted under
-- the old rule, expiring between 7 and 31 Aug 2026. They are NOT cleared here:
-- revoking access someone was already given is a product decision, not a
-- migration's call, and letting them lapse naturally costs nothing.
--
-- To end them immediately instead (every one of those users drops to Free on
-- their next request):
--   update public.profiles set trial_ends_at = null where trial_ends_at > now();
--
-- To verify only new signups are affected:
--   select count(*) filter (where trial_ends_at > now()) as still_on_trial,
--          count(*)                                      as profiles
--   from public.profiles;
