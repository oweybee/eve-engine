-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260807155634, name revoke_client_write_grants_on_views. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- The same revocation, for VIEWS and MATERIALIZED VIEWS.
--
-- The previous migration scoped itself to `relkind in ('r','p')` and left 32
-- anon write grants standing on the eight public views. Not a live hole — all
-- eight are `security_invoker`, so a write through an auto-updatable view is
-- checked against the base table's RLS and grants as the CALLER, which the
-- previous migration just closed; and TRUNCATE on a view is an error, not a
-- risk. But an audit that reports "anon holds 32 write grants" is an audit
-- nobody can read at a glance, and the whole point of that migration was that
-- the grant should not be there whether or not something else saves it.
--
-- Nothing in this product writes through a view. `league_directory` is read by
-- the board's league navigation; the rest are engine and reporting surfaces.
-- SELECT is untouched throughout.

do $$
declare r record; n int := 0;
begin
  for r in
    select t.relname, roles.rolename, cmd.priv
    from pg_class t
    join pg_namespace ns on ns.oid = t.relnamespace and ns.nspname = 'public'
    cross join (select unnest(array['anon','authenticated']) as rolename) roles
    cross join (select unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as priv) cmd
    where t.relkind in ('v','m')
      and exists (
        select 1 from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = t.relname
          and g.grantee = roles.rolename and g.privilege_type = cmd.priv)
  loop
    execute format('revoke %s on public.%I from %I', r.priv, r.relname, r.rolename);
    n := n + 1;
  end loop;
  raise notice 'revoked % view write grants', n;
end $$;

-- The client write surface is now exactly four tables, and it is asserted
-- rather than assumed.
do $$
declare surplus text;
begin
  select string_agg(format('%s→%s.%s', g.grantee, g.table_name, g.privilege_type), ', ')
    into surplus
  from information_schema.role_table_grants g
  where g.table_schema = 'public'
    and g.grantee in ('anon','authenticated')
    and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
    and not (g.grantee = 'authenticated'
             and g.table_name in ('bets','bankroll_transactions','preferences','user_bookmakers')
             and g.privilege_type in ('INSERT','UPDATE','DELETE'));

  if surplus is not null then
    raise exception 'unexpected client write grant survived: %', surplus;
  end if;
end $$;
