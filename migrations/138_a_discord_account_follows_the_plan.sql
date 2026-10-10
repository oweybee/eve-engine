-- 138 - a linked Discord account follows the plan
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
--
-- #signals in the MaxEdge Discord is Plus only (owner ruling, 9 Oct 2026). The
-- Plus role was handed out by hand. From here a member links their Discord
-- account on /me/settings (OAuth, `identify` scope only), the link is stored
-- in `discord_links`, and `syncDiscordRoles.js` in eve-engine gives or removes
-- the role every ten minutes from what the DATABASE says the member's tier is.
--
-- The sync follows the profile, not Stripe events. A missed webhook, a refund
-- done by hand in the Stripe dashboard, a trial running out at 3am: whatever
-- moved the tier, the next run moves the role to match. It fixes itself.
--
-- ── ONE TIER RULE, NOT TWO ───────────────────────────────────────────────────
--
-- `current_tier()` is the authority every RLS policy asks, and it only answers
-- for `auth.uid()`. The sync runs as the service role for every linked member,
-- so it needs the same rule for any user id. Copying the CASE into a view is
-- the MODEL_SIGMA mistake (a hand-copy of a rule that lives somewhere else
-- fails silently, in whichever direction), so the rule now lives in
-- `tier_for(uuid)` and `current_tier()` is redefined as `tier_for(auth.uid())`.
-- Same body, same STABLE SECURITY DEFINER, same search_path. Checked on apply:
-- tier_for(id) equals the old CASE for every profile.
--
-- `tier_for` is NOT executable by anon or authenticated: it answers for any
-- user id, which would let one member read another's plan. current_tier()
-- still calls it, because a SECURITY DEFINER function runs as its owner.
--
-- ── WHAT A MEMBER CAN DO TO THEIR OWN ROW ────────────────────────────────────
--
-- Read it. Nothing else. Links are written by the OAuth callback on the
-- service role, after Discord itself has told us whose account it is; a
-- member who could write `discord_user_id` could hand the Plus role to any
-- Discord account they liked.

create or replace function public.tier_for(uid uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  select coalesce((
    select case
      when p.trial_ends_at is not null and p.trial_ends_at > now()
           and coalesce(p.tier, 'free') = 'free'
        then 'edge'
      else coalesce(p.tier, 'free')
    end
    from public.profiles p
    where p.id = uid
  ), 'free');
$function$;

revoke all on function public.tier_for(uuid) from public, anon, authenticated;
grant execute on function public.tier_for(uuid) to service_role;

create or replace function public.current_tier()
returns text
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  select public.tier_for(auth.uid());
$function$;

create table if not exists public.discord_links (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  discord_user_id  text not null unique check (discord_user_id ~ '^[0-9]{15,21}$'),
  discord_username text,
  linked_at        timestamptz not null default now(),
  -- What the last sync found and did. 'pending' until the first run.
  role_state       text not null default 'pending'
                   check (role_state in ('pending', 'plus', 'no_plus', 'not_in_server', 'error')),
  role_synced_at   timestamptz,
  role_note        text
);

comment on table public.discord_links is
  'One Discord account per MaxEdge member. Written by /api/discord/callback (service role); the Plus role is synced from tier_for() by eve-engine syncDiscordRoles.js. Migration 138.';

alter table public.discord_links enable row level security;

revoke all on public.discord_links from anon, authenticated;
grant select on public.discord_links to authenticated;

drop policy if exists discord_links_read_own on public.discord_links;
create policy discord_links_read_own on public.discord_links
  for select to authenticated
  using (user_id = auth.uid());

-- The sync's one read: every link and whether its member should hold Plus.
-- Any tier that is not 'free' ranks as Plus, exactly as lib/portal/tiers does
-- (legacy starter/edge/pro and the trial's 'edge' all resolve to Plus).
create or replace view public.discord_role_targets
with (security_invoker = true) as
select l.user_id,
       l.discord_user_id,
       l.role_state,
       public.tier_for(l.user_id) <> 'free' as wants_plus
from public.discord_links l;

revoke all on public.discord_role_targets from anon, authenticated;
grant select on public.discord_role_targets to service_role;
