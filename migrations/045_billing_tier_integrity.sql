-- 045_billing_tier_integrity.sql
--
-- APPLIED to production 2026-08-02, and re-verified live afterwards (every
-- check below run against production inside a transaction and rolled back):
--   • service_role can write tier='plus'                        → succeeds
--   • a plus user with an EXPIRED trial reads the full dataset  → 341 signals,
--     37,592 predictions, 308 recommendations, 26 accas
--   • a member self-granting tier='edge'                        → permission denied
--   • a member extending their own trial_ends_at                → permission denied
--   • naming tier in an INSERT at signup                        → permission denied
--   • first sign-in inserting {id, email}                       → succeeds, lands on 'free'
-- Profile rows were unchanged by the verification (2 'edge', 10 'free').
--
-- PROBLEM 1 (Critical — paid upgrades cannot be granted). The two-tier collapse
-- to free/plus happened in the frontend only. The database still carries the
-- pre-collapse vocabulary:
--
--     profiles_tier_check CHECK (tier IN ('free','starter','edge','pro'))
--
-- 'plus' is not in that list, and 'plus' is exactly what the Stripe webhook
-- writes on a successful payment (lib/stripeSync.js: profiles.update({ tier })
-- with effectiveTier = 'plus'). Every paid upgrade is therefore rejected by the
-- database with a 23514 check violation — including when the webhook runs as
-- service_role, which bypasses RLS but not CHECK constraints. This is why
-- profiles has never held a single 'plus' row.
--
-- PROBLEM 2 (Critical — the wall can be walked around). RLS on the premium
-- tables gates on `current_tier() <> 'free'` (034), and current_tier() reads
-- profiles.tier / profiles.trial_ends_at. But anon and authenticated hold
-- TABLE-level INSERT/UPDATE on public.profiles, and profiles_update_own
-- restricts only WHICH ROW you may write (auth.uid() = id), not WHICH COLUMNS.
-- So any logged-in free user can grant themselves the paid product:
--
--     supabase.from('profiles').update({ tier: 'edge' }).eq('id', myId)
--     supabase.from('profiles').update({ trial_ends_at: '2099-01-01' })…
--
-- 'edge' is still permitted by the old CHECK, satisfies `<> 'free'`, and ranks
-- as Plus in lib/portal/tiers.js — so it unlocks everything. Extending one's own
-- trial does the same via current_tier()'s trial branch. Both were confirmed
-- against production (rolled back): value_signals 5 → 337, fixture_predictions
-- 0 → 37,592. is_admin is self-writable by the same route.
--
-- FIX:
--   1. Admit 'plus' to the tier vocabulary, keeping the legacy values so
--      existing comped/legacy rows (two 'edge' profiles, one 'pro' tier_grant)
--      keep working and continue to resolve to Plus in the frontend.
--   2. Make the billing columns server-writable only: drop the blanket
--      table-level INSERT/UPDATE and re-grant just the columns the app
--      legitimately writes. The Stripe webhook is unaffected — it uses the
--      service-role key, whose grant is untouched.
--
-- NOT CHANGED HERE (deliberately):
--   • current_tier() still returns 'edge' for an active trial. It is legacy
--     vocabulary and reads oddly, but it is behaviourally correct (it satisfies
--     `<> 'free'` and ranks as Plus) and CLAUDE.md flags the function as
--     verified in production. Renaming it to 'plus' is a follow-up, not part of
--     a security fix.
--   • The 30-day signup trial in handle_new_portal_user() is product design,
--     not a defect, and is left alone.

begin;

-- ── 1. Tier vocabulary: admit 'plus' ─────────────────────────────────────────
-- Legacy values stay permitted: lib/portal/tiers.js maps starter/edge/pro to
-- Plus for pre-collapse subscribers, and dropping them here would orphan real
-- rows that currently hold them.
alter table public.profiles drop constraint if exists profiles_tier_check;
alter table public.profiles add constraint profiles_tier_check
  check (tier in ('free', 'plus', 'starter', 'edge', 'pro'));

alter table public.tier_grants drop constraint if exists tier_grants_tier_check;
alter table public.tier_grants add constraint tier_grants_tier_check
  check (tier in ('free', 'plus', 'starter', 'edge', 'pro'));

-- ── 2. Billing columns become server-writable only ───────────────────────────
-- The existing grant is table-level (relacl 'arwdDxtm' for anon/authenticated),
-- and Postgres will not let you revoke a subset of columns from a table-level
-- grant — the whole privilege has to go before column grants mean anything.
revoke insert, update on public.profiles from anon, authenticated;

-- Re-grant only what the app actually writes. contexts/AuthContext.js inserts
-- {id, email} on first sign-in; nothing in either repo updates a profile
-- client-side today, so UPDATE(email) is the conservative allowance rather than
-- a known requirement. tier / trial_ends_at / is_admin / status are now
-- writable only by service_role (the Stripe webhook) and the SECURITY DEFINER
-- signup trigger, both of which are unaffected by this revoke.
grant insert (id, email) on public.profiles to authenticated;
grant update (email)     on public.profiles to authenticated;

-- tier_grants is an operator-only comp list; it should never have been
-- client-writable either. RLS already has no policy for it, but the table-level
-- grant is removed so a future policy cannot accidentally expose it.
revoke insert, update, delete on public.tier_grants from anon, authenticated;

commit;

-- ── Verification ─────────────────────────────────────────────────────────────
-- Run after applying. Expected results noted inline.
--
--   -- (a) the webhook's write now succeeds
--   begin;
--     set local role service_role;
--     update public.profiles set tier='plus' where id='<some-user>';
--     select tier from public.profiles where id='<some-user>';   -- 'plus'
--   rollback;
--
--   -- (b) a free user can no longer grant themselves the product
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<some-user>","role":"authenticated"}';
--     update public.profiles set tier='edge' where id='<some-user>';
--     -- ERROR: permission denied for table profiles
--   rollback;
--
-- Rollback of this migration (restores the broken state — for emergencies only):
--   alter table public.profiles drop constraint profiles_tier_check;
--   alter table public.profiles add constraint profiles_tier_check
--     check (tier in ('free','starter','edge','pro'));
--   grant insert, update on public.profiles to anon, authenticated;
--   grant insert, update, delete on public.tier_grants to anon, authenticated;
