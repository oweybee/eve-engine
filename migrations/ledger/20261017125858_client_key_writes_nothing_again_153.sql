-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261017125858, name client_key_writes_nothing_again_153. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

do $$
declare r record;
begin
  for r in
    select c.oid::regclass as rel, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','v','m','p','f')
  loop
    execute format('revoke insert, update, delete, truncate on %s from anon', r.rel);
    if r.relname not in ('bets','bankroll_transactions','preferences','user_bookmakers','telegram_links','profiles') then
      execute format('revoke insert, update, delete, truncate on %s from authenticated', r.rel);
    end if;
  end loop;
end $$;
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;
do $$
declare n int;
begin
  select count(*) into n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace,
       unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
  where s.nspname = 'public' and c.relkind in ('r','v','m','p','f')
    and has_table_privilege('anon', c.oid, p);
  if n <> 0 then raise exception '153: anon still holds % write privileges', n; end if;
  select count(*) into n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace,
       unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
  where s.nspname = 'public' and c.relkind in ('r','v','m','p','f')
    and has_table_privilege('authenticated', c.oid, p)
    and c.relname not in ('bets','bankroll_transactions','preferences','user_bookmakers','telegram_links');
  if n <> 0 then raise exception '153: authenticated still writes % unexpected privileges', n; end if;
  if not (has_table_privilege('authenticated','public.bets','insert')
      and has_table_privilege('authenticated','public.preferences','update')
      and has_table_privilege('authenticated','public.user_bookmakers','delete')
      and has_table_privilege('authenticated','public.bankroll_transactions','insert')
      and has_column_privilege('authenticated','public.profiles','email','update')) then
    raise exception '153: a member write path was lost';
  end if;
  if not has_table_privilege('anon','public.v_odds_extra_history','select') then
    raise exception '153: the read path the board uses was lost';
  end if;
end $$;
