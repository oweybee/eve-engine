-- 153 — the client key writes nothing, again, and new tables stop inheriting it
--
-- FOUND 17 Oct 2026 in a security review. The 7 Aug lockdown left `anon` with
-- ZERO write privileges, and it has quietly regressed: `pg_default_acl` grants
-- anon and authenticated INSERT/UPDATE/DELETE/TRUNCATE on EVERY new table in
-- `public`, so each table added since (odds_extra, predictor_*, prime_alerts,
-- x_mirror_*, gate_watch, ...) arrived writable from the browser bundle's key.
--
-- Most of that was held by RLS (enabled, no policies). One was not:
-- `v_odds_extra_history` is an auto-updatable view owned by postgres with no
-- security_invoker, so writes through it run with the owner's rights and skip
-- RLS. Probed as anon inside a rolled-back transaction: a bare
-- `delete from v_odds_extra_history` reached 7,223 rows of `odds_extra`.
-- PostgREST exposes DELETE on views, so that was reachable with the public key.
-- (117 recorded this as an open item on 16 Oct; this closes it.)
--
-- THE RULE, not a list: anon may write nothing; authenticated may write only
-- the member tables that carry their own policies. Column-level grants on
-- APPLIED AND VERIFIED 17 Oct 2026 (as client_key_writes_nothing_again_153).
-- `profiles` (045) are untouched, and that needs care: Postgres removes the
-- column grants along with a table-level revoke, so profiles is skipped for
-- authenticated. telegram_links carries own-row INSERT/UPDATE policies.
-- The default ACL is changed for role postgres so the next table is born
-- read-only to the client roles. Reverse with `grant <priv> on <rel> to <role>`.

begin;

do $$
declare r record;
begin
  for r in
    select c.oid::regclass as rel, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','v','m','p','f')
  loop
    execute format('revoke insert, update, delete, truncate on %s from anon', r.rel);
    -- profiles is skipped, not forgotten: a TABLE-level revoke also removes
    -- the COLUMN grants 045 left (INSERT id/email, UPDATE email), which is
    -- exactly what the rehearsal of this file caught. It holds no table-level
    -- write to revoke.
    if r.relname not in ('bets','bankroll_transactions','preferences','user_bookmakers','telegram_links','profiles') then
      execute format('revoke insert, update, delete, truncate on %s from authenticated', r.rel);
    end if;
  end loop;
end $$;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate on tables from anon, authenticated;

-- Assertions: the hole is shut, nothing client-facing broke.
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

commit;
