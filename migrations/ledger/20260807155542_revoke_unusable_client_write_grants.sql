-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260807155542, name revoke_unusable_client_write_grants. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Revoke every anon/authenticated write grant that RLS already denies, and
-- every TRUNCATE grant, which RLS does not cover at all.
--
-- WHY. `anon` held INSERT, UPDATE, DELETE and TRUNCATE on ~66 public tables,
-- including bets, profiles, matches, value_signals and model_calibration. None
-- of it was exploitable today: RLS denies the writes, PostgREST exposes no
-- TRUNCATE verb, and all eight public views are security_invoker so nothing
-- leaks past the tier gate. But RLS is then the ONLY thing standing between the
-- anon key — which ships in the browser bundle — and the whole dataset, and
-- TRUNCATE is not governed by RLS at any time. One RPC with a loose search_path,
-- or one table shipped with RLS off, and `bets` empties.
--
-- This is the same shape as the hole migration 045 closed on `profiles`, where
-- a blanket table-level grant let any member set their own tier. Defence in
-- depth: the grant should not be there whether or not a policy currently saves
-- it.
--
-- THE RULE, NOT A LIST. The set is DERIVED here rather than pasted, so it cannot
-- be stale by the time it runs: revoke a privilege only where no PERMISSIVE
-- policy could ever admit it for that role. Anything a policy does admit is left
-- exactly as it is.
--
-- WHAT SURVIVES, and it is the entire client write surface:
--   bets, bankroll_transactions, preferences, user_bookmakers  → authenticated
--   profiles                                                   → authenticated,
--     INSERT(id, email) and UPDATE(email) — COLUMN-level grants from 045, which
--     this migration cannot touch because it only revokes where a TABLE-level
--     grant exists, and `REVOKE UPDATE ON t` would take the column grants with
--     it. Asserted below.
--   everything service_role and postgres hold                  → untouched.
--
-- Reversible: `grant <priv> on public.<table> to <role>` puts any of it back.

do $$
declare
  r          record;
  n_revoked  int := 0;
  n_truncate int := 0;
begin
  -- 1. INSERT / UPDATE / DELETE that no policy can admit.
  for r in
    select t.relname, roles.rolename, cmd.priv
    from pg_class t
    join pg_namespace ns on ns.oid = t.relnamespace and ns.nspname = 'public'
    cross join (select unnest(array['anon','authenticated']) as rolename) roles
    cross join (select * from (values ('INSERT','a'),('UPDATE','w'),('DELETE','d')) v(priv, code)) cmd
    where t.relkind in ('r','p')
      -- only where a TABLE-level grant actually exists. This is what keeps the
      -- statement away from `profiles`, whose INSERT/UPDATE are column-level.
      and exists (
        select 1 from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = t.relname
          and g.grantee = roles.rolename and g.privilege_type = cmd.priv)
      -- and where no permissive policy could ever admit it for this role.
      and not exists (
        select 1 from pg_policy p
        where p.polrelid = t.oid and p.polpermissive
          and p.polcmd in (cmd.code, '*')
          and (p.polroles = '{0}'::oid[]
               or (select o.oid from pg_roles o where o.rolname = roles.rolename) = any(p.polroles)))
  loop
    execute format('revoke %s on public.%I from %I', r.priv, r.relname, r.rolename);
    n_revoked := n_revoked + 1;
  end loop;

  -- 2. TRUNCATE, unconditionally. RLS never covers it, so a policy is no
  --    defence, and nothing in this product truncates from a client key.
  for r in
    select t.relname, roles.rolename
    from pg_class t
    join pg_namespace ns on ns.oid = t.relnamespace and ns.nspname = 'public'
    cross join (select unnest(array['anon','authenticated']) as rolename) roles
    where t.relkind in ('r','p')
      and exists (
        select 1 from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = t.relname
          and g.grantee = roles.rolename and g.privilege_type = 'TRUNCATE')
  loop
    execute format('revoke truncate on public.%I from %I', r.relname, r.rolename);
    n_truncate := n_truncate + 1;
  end loop;

  raise notice 'revoked % write grants and % truncate grants', n_revoked, n_truncate;
end $$;

-- 3. ASSERT THE CLIENT STILL WORKS. A permission migration that silently locks
--    out a real write path is worse than the hole it closed, so the four paths
--    the browser actually uses are checked here rather than in a screenshot.
do $$
declare missing text;
begin
  select string_agg(format('%s.%s', t, p), ', ')
    into missing
  from (values
    ('bets','INSERT'), ('bets','UPDATE'), ('bets','DELETE'),
    ('bankroll_transactions','INSERT'), ('bankroll_transactions','UPDATE'), ('bankroll_transactions','DELETE'),
    ('preferences','INSERT'), ('preferences','UPDATE'), ('preferences','DELETE'),
    ('user_bookmakers','INSERT'), ('user_bookmakers','UPDATE'), ('user_bookmakers','DELETE')
  ) as needed(t, p)
  where not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = needed.t
      and g.grantee = 'authenticated' and g.privilege_type = needed.p);

  if missing is not null then
    raise exception 'client write path lost its grant: %', missing;
  end if;

  -- profiles keeps its COLUMN-level grants from migration 045.
  if not exists (
    select 1 from information_schema.column_privileges
    where table_schema='public' and table_name='profiles' and grantee='authenticated'
      and privilege_type='UPDATE' and column_name='email')
  then
    raise exception 'profiles.email UPDATE column grant was lost — migration 045 undone';
  end if;
end $$;
