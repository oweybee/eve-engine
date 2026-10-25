-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260819204115, name vf_export_temp. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- TEMPORARY verification export. Dropped at the end of this session.
-- Carries only league ids, a result code and a rating gap: no prices, no user
-- data, nothing a reader could not derive from public results.
create or replace view vf_export with (security_invoker = off) as
select f.h_lg::text as h, f.a_lg::text as a,
       case f.result when 'home' then 0 when 'draw' then 1 else 2 end as r,
       round((p.h_elo + 80 - p.a_elo)::numeric, 6)::float8 as base,
       (cl.name like 'UEFA%') as uefa
from vf_fit f
join vf_prematch p on p.id = f.id
join leagues cl on cl.id = f.comp
where least(p.h_games, p.a_games) >= 30;

grant select on vf_export to anon;
