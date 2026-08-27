-- 112_telegram_channel_membership.sql
--
-- Owner request, 27 Aug 2026: offer every trialling or paying member a Telegram
-- invite to both channels on signup, and when a subscription lapses either kick
-- the member out or tell the owner who to remove by hand. This is the eve-engine
-- half of a two-repo feature — eve-frontend (branch claude/sharp-hawking-rifvcy)
-- owns issuing the invite links and recording a join, over the same table this
-- migration creates. Neither repo has ever managed Telegram MEMBERSHIP before;
-- postToX.js only ever posts one-way into TELEGRAM_CHAT_ID and
-- TELEGRAM_INPLAY_CHAT_ID, and there is no invite/kick code anywhere in this
-- repo prior to this file.
--
-- ── THE TABLE ────────────────────────────────────────────────────────────────
--
-- One row per member, two channels on it (signals, inplay) rather than two
-- tables, because every join/kick/revoke decision is made per-channel off the
-- same entitlement check and a single row keeps that pairing visible. Each
-- channel carries its own invite link, status and Telegram user id, because a
-- member can join one channel and not the other, or be kicked from one while
-- still entitled to the other (unlikely today — both gate on the same Plus
-- entitlement — but nothing here assumes they will always be granted together).
--
-- `signals_status` / `inplay_status` follow the lifecycle a channel invite
-- actually goes through: none (never offered) -> invited (link issued, not
-- confirmed joined) -> joined (webhook confirmed) -> kicked (we removed them,
-- ban+unban so it is not permanent) / revoked (their invite link was pulled
-- before they used it) / left (they left on their own — eve-frontend's webhook
-- sets this on a `left_chat_member` update; this migration does not write it).
--
-- ── THE ENTITLEMENT FUNCTION, READ FROM THE LIVE DATABASE, NOT GUESSED ───────
--
-- CLAUDE.md (both repos) records `current_tier()`'s trial/tier logic being
-- hand-copied and going wrong twice — MARKET_ANCHORED missing from a typed
-- copy of `model_calibration`, and a board scored against the wrong
-- architecture's sigma. `is_plus_entitled(uuid)` below is a second copy of
-- that same shape of question (is this user still paying), so it does not
-- reimplement `current_tier()`'s logic from memory or from CLAUDE.md's prose
-- description of it. Its body was read directly off production with
-- `pg_get_functiondef(oid)` against `pg_proc` (this session has Supabase MCP
-- read access to the live `MaxEdge Project`, unusually — see the PR
-- description) and is reproduced verbatim below, applied to `p_user_id`
-- instead of `auth.uid()`:
--
--   CREATE OR REPLACE FUNCTION public.current_tier()
--    RETURNS text
--    LANGUAGE sql
--    STABLE SECURITY DEFINER
--    SET search_path TO 'public', 'pg_catalog'
--   AS $function$
--     select coalesce((
--       select case
--         when p.trial_ends_at is not null and p.trial_ends_at > now()
--              and coalesce(p.tier, 'free') = 'free'
--           then 'edge'
--         else coalesce(p.tier, 'free')
--       end
--       from public.profiles p
--       where p.id = auth.uid()
--     ), 'free');
--   $function$
--
-- `is_plus_entitled` returns the same boolean `current_tier() <> 'free'` would
-- return for that user — the legacy 'edge'-on-trial value ranks as Plus, same
-- as everywhere else in this product (045's note: "behaviourally correct […]
-- renaming it to 'plus' is a follow-up, not part of a fix" — still true, still
-- not this migration's job). It does NOT call `current_tier()` itself, because
-- that function reads `auth.uid()` and the reconciliation job below runs as
-- service_role with no caller — it has to ask about MANY users, one at a time,
-- from a context with no session user at all.
--
-- SECURITY DEFINER, and revoked from public/anon/authenticated: this must
-- never become a way for one member to query another member's subscription
-- status. Migration 107 is the reason the revoke names all three (public, anon
-- AND authenticated) rather than the two named roles alone — Postgres grants
-- EXECUTE to PUBLIC on every function it creates and `anon`/`authenticated`
-- inherit through that grant even after being revoked by name, which is why
-- seven earlier migrations (097-106) each tried a two-role revoke on other
-- functions and none of them worked. Grant is to service_role only.
--
-- ── WHAT WAS AND WAS NOT DONE HERE ───────────────────────────────────────────
--
-- No invite-link generation, no Telegram webhook and no join/leave recording —
-- that is eve-frontend's half of the contract, over this same table. This repo
-- only reads `telegram_links` (from `reconcileTelegramAccess.js`, added
-- alongside this migration) to decide who to kick or flag for the owner, and
-- writes `*_status` when it acts.
--
-- ── VERIFICATION ─────────────────────────────────────────────────────────────
--
-- Probed in a rolled-back transaction against the live `MaxEdge Project`
-- database in this session (this file's `commit;` was replaced with
-- `rollback;` for that run and nothing below was applied for real) — the
-- assertions inside the `do $$ … end $$` blocks below are exactly what ran:
--   • `is_plus_entitled()` agrees with the `current_tier()` case expression
--     above on EVERY row of the live `profiles` table (19 rows: 15 free, 2
--     plus, 2 edge at the time of the probe).
--   • RLS on `telegram_links` isolates two real profile ids from each other —
--     own-row select/insert/update succeed, cross-user select returns zero
--     rows and a cross-user insert is denied — using a real pair of ids from
--     the live `profiles` table, then deleting the probe row before the
--     transaction rolled back regardless.
--   • `is_plus_entitled` carries no PUBLIC, anon or authenticated EXECUTE
--     grant and service_role keeps it, checked with `has_function_privilege`
--     per migration 107's method.
--
-- THIS MIGRATION HAS NOT BEEN APPLIED TO PRODUCTION. That rehearsal is the
-- extent of the verification — see the PR description for exactly what that
-- does and does not establish, and for why it was not applied for real anyway.
--
-- Reversible:
--   drop trigger if exists telegram_links_set_updated_at on public.telegram_links;
--   drop table if exists public.telegram_links;
--   revoke execute on function public.is_plus_entitled(uuid) from service_role;
--   drop function if exists public.is_plus_entitled(uuid);

begin;

-- ── 1. The table ─────────────────────────────────────────────────────────────

create table if not exists public.telegram_links (
  user_id uuid primary key references public.profiles(id) on delete cascade,

  signals_invite_link text,
  signals_status text not null default 'none'
    check (signals_status in ('none','invited','joined','kicked','revoked','left')),
  signals_telegram_user_id bigint,
  signals_joined_at timestamptz,

  inplay_invite_link text,
  inplay_status text not null default 'none'
    check (inplay_status in ('none','invited','joined','kicked','revoked','left')),
  inplay_telegram_user_id bigint,
  inplay_joined_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;

-- Same InitPlan wrapping as every policy since migration 059: `auth.uid()` is
-- STABLE and Postgres does not hoist a bare call out of a row filter on its
-- own, so `(select auth.uid())` is what makes it evaluate once per query
-- rather than once per row.
create policy telegram_links_own_read on public.telegram_links
  for select using ((select auth.uid()) = user_id);

create policy telegram_links_own_insert on public.telegram_links
  for insert with check ((select auth.uid()) = user_id);

create policy telegram_links_own_update on public.telegram_links
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy: nothing in this product deletes a row here. The FK's
-- `on delete cascade` still removes it when the profile itself is deleted.

create trigger telegram_links_set_updated_at
  before update on public.telegram_links
  for each row execute function public.set_updated_at();

-- service_role (the engine, running as itself, not as any member) needs no
-- explicit grant here: it bypasses RLS and holds the standing table-level
-- privileges Supabase grants that role on every table by default. Nothing in
-- this migration widens what anon or authenticated may do to any OTHER
-- product table.

-- ── 1b. Table privileges — explicit, not the inherited default ──────────────
--
-- Checked live: `pg_default_acl` for schema public carries
-- `anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres` for new relations
-- — Supabase's default is every table privilege (including DELETE and
-- TRUNCATE) to BOTH roles on any table the migration role creates. The 7 Aug
-- 2026 write-revoke this repo's CLAUDE.md documents ("anon holds ZERO write
-- privileges on any public relation, and authenticated holds INSERT/UPDATE/
-- DELETE on exactly four tables") narrowed every EXISTING table at the time;
-- it did not — could not — reach a table created afterward. Left alone, this
-- one would open at the default: anon with full read/write on every row (RLS
-- still empties it in practice, since anon carries no `auth.uid()`, but "RLS
-- as the ONLY thing between the browser bundle's anon key and the whole
-- dataset" is exactly the shape that migration was written to stop being
-- true). Narrowed explicitly here instead, matching that migration's own
-- rule — asserted in section 6, not eyeballed.
revoke all on public.telegram_links from anon;
revoke all on public.telegram_links from authenticated;
-- No delete grant to either role: nothing in this contract deletes a row
-- directly (the FK cascade is what removes one, on the profile going away),
-- and there is no delete POLICY above for a delete privilege to pass through
-- even if a caller had it.
grant select, insert, update on public.telegram_links to authenticated;

-- ── 2. The entitlement helper ────────────────────────────────────────────────

create or replace function public.is_plus_entitled(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select coalesce((
    select case
      when p.trial_ends_at is not null and p.trial_ends_at > now()
           and coalesce(p.tier, 'free') = 'free'
        then true
      else coalesce(p.tier, 'free') <> 'free'
    end
    from public.profiles p
    where p.id = p_user_id
  ), false);
$$;

revoke all on function public.is_plus_entitled(uuid) from public, anon, authenticated;
grant execute on function public.is_plus_entitled(uuid) to service_role;

-- ── 3. Assert the table and its policies behave as intended ─────────────────
--
-- Probed with a REAL insert against a real profile pair, inside a savepoint
-- (the `begin … exception … end` block) that either raises to undo it or is
-- itself inside the outer transaction this whole file rolls back when rehearsed
-- — migration 108's method, so a probe insert never survives even the run that
-- exercises it, whether this file ends in `commit` or `rollback`.

do $$
declare
  v_user_a uuid;
  v_user_b uuid;
  v_cnt    int;
  v_status text;
begin
  select id into v_user_a from public.profiles order by created_at asc  limit 1;
  select id into v_user_b from public.profiles order by created_at desc limit 1;
  if v_user_a is null or v_user_b is null or v_user_a = v_user_b then
    raise exception '112 FAILED: need at least two distinct profiles to probe cross-user RLS isolation (have %/%)', v_user_a, v_user_b;
  end if;

  -- Own-row insert and read, as user A. `set_config(…, true)` is the
  -- LOCAL-to-transaction form of SET for a value that has to be computed
  -- (a plain `set local x = <expr>` statement does not accept an expression).
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);

  insert into public.telegram_links (user_id, signals_status) values (v_user_a, 'invited');

  select count(*) into v_cnt from public.telegram_links where user_id = v_user_a;
  if v_cnt <> 1 then
    raise exception '112 FAILED: user A could not read the telegram_links row they just inserted';
  end if;

  -- Own-row update, as user A.
  update public.telegram_links set signals_status = 'joined' where user_id = v_user_a;
  select signals_status into v_status from public.telegram_links where user_id = v_user_a;
  if v_status is distinct from 'joined' then
    raise exception '112 FAILED: user A''s own-row update did not stick (read back %)', v_status;
  end if;

  -- Cross-user read: user A must see nothing at user B's row, whether or not
  -- one exists — this is a read isolation check, not a presence check.
  select count(*) into v_cnt from public.telegram_links where user_id = v_user_b;
  if v_cnt <> 0 then
    raise exception '112 FAILED: user A can read a telegram_links row belonging to user B';
  end if;

  -- Cross-user insert must be DENIED — user A attempting to write a row
  -- claiming to be user B's.
  begin
    insert into public.telegram_links (user_id) values (v_user_b);
    raise exception '112 FAILED: user A was able to insert a telegram_links row for user B';
  exception
    when others then
      if sqlerrm like '112 FAILED%' then raise; end if;
      -- expected path: RLS denies with "new row violates row-level security policy"
  end;

  reset role;

  -- Clean up the probe row so the table is empty again regardless of how this
  -- run ends (rehearsal-rollback or a real commit).
  delete from public.telegram_links where user_id = v_user_a;

  raise notice '112: telegram_links RLS isolation verified for a real profile pair (% / %)', v_user_a, v_user_b;
end $$;

-- ── 4. Assert is_plus_entitled() agrees with current_tier()'s own case logic
--       on EVERY row of the live profiles table, not a sample. ───────────────

do $$
declare
  v_bad   int;
  v_total int;
begin
  select count(*) into v_total from public.profiles;

  select count(*) into v_bad
  from public.profiles p
  where public.is_plus_entitled(p.id) is distinct from (
    case
      when p.trial_ends_at is not null and p.trial_ends_at > now()
           and coalesce(p.tier, 'free') = 'free'
        then true
      else coalesce(p.tier, 'free') <> 'free'
    end
  );

  if v_bad > 0 then
    raise exception '112 FAILED: is_plus_entitled() disagrees with current_tier()''s own case logic on % of % profile row(s)', v_bad, v_total;
  end if;

  raise notice '112: is_plus_entitled() agrees with current_tier() on all % profile row(s)', v_total;
end $$;

-- ── 5. Assert the function grant, the same way 107 checked one ──────────────

do $$
begin
  if has_function_privilege('anon', 'public.is_plus_entitled(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '112 FAILED: anon holds EXECUTE on is_plus_entitled';
  end if;
  if has_function_privilege('authenticated', 'public.is_plus_entitled(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '112 FAILED: authenticated holds EXECUTE on is_plus_entitled';
  end if;
  if exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.is_plus_entitled(uuid)'::regprocedure and a.grantee = 0
  ) then
    raise exception '112 FAILED: a PUBLIC grant survives on is_plus_entitled';
  end if;
  if not has_function_privilege('service_role', 'public.is_plus_entitled(uuid)'::regprocedure, 'EXECUTE') then
    raise exception '112 FAILED: service_role lost EXECUTE on is_plus_entitled — the reconciliation job could not call it';
  end if;
  raise notice '112: is_plus_entitled is service_role-only, no PUBLIC/anon/authenticated grant survives.';
end $$;

-- ── 6. Assert the table grants — anon has nothing, authenticated has exactly
--       select/insert/update, service_role is untouched by any of the above ─

do $$
begin
  if has_table_privilege('anon', 'public.telegram_links', 'SELECT')
  or has_table_privilege('anon', 'public.telegram_links', 'INSERT')
  or has_table_privilege('anon', 'public.telegram_links', 'UPDATE')
  or has_table_privilege('anon', 'public.telegram_links', 'DELETE') then
    raise exception '112 FAILED: anon holds a table privilege on telegram_links';
  end if;

  if not has_table_privilege('authenticated', 'public.telegram_links', 'SELECT')
  or not has_table_privilege('authenticated', 'public.telegram_links', 'INSERT')
  or not has_table_privilege('authenticated', 'public.telegram_links', 'UPDATE') then
    raise exception '112 FAILED: authenticated is missing select/insert/update on telegram_links';
  end if;
  if has_table_privilege('authenticated', 'public.telegram_links', 'DELETE') then
    raise exception '112 FAILED: authenticated holds DELETE on telegram_links — no delete policy exists to bound it';
  end if;

  if not has_table_privilege('service_role', 'public.telegram_links', 'SELECT')
  or not has_table_privilege('service_role', 'public.telegram_links', 'UPDATE') then
    raise exception '112 FAILED: service_role cannot read/update telegram_links — the reconciliation job could not run';
  end if;

  raise notice '112: table grants are exact — anon none, authenticated select/insert/update, service_role untouched.';
end $$;

commit;
