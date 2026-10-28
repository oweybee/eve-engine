-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260706120425, name portal_self_provision_policies. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Allow a signed-in user to self-provision their own profile/preferences row
-- (fallback for accounts that predate the signup trigger). Still strictly own-row.
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists preferences_insert_own on public.preferences;
create policy preferences_insert_own on public.preferences
  for insert to authenticated with check (auth.uid() = user_id);
