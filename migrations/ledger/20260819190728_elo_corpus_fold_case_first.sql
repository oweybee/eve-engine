-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260819190728, name elo_corpus_fold_case_first. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace view elo_corpus with (security_invoker = on) as
with canon as (
  select t.id as team_id, coalesce(t2.name, t.name) as cname
  from teams t
  left join team_aliases al on al.alias_team_id = t.id
  left join teams t2 on t2.id = al.canonical_team_id
),
keyed as (
  select team_id, cname,
    regexp_replace(translate(lower(cname),
      'àáâãäåāăąèéêëēĕėęěìíîïīįıòóôõöøōőùúûüūůűýÿñńňçćčšśşžźżďđðğģķļłřŕťţþ',
      'aaaaaaaaaeeeeeeeeeiiiiiiioooooooouuuuuuuyynnncccssszzzdddggkllrrttt'),
      '[^a-z0-9]', '', 'g') as k
  from canon
),
base as (
  select m.id, m.kickoff_at, m.result, m.league_id, m.external_id,
         kh.k as home_key, ka.k as away_key,
         kh.cname as home_name, ka.cname as away_name,
         (m.external_id ~ '^[0-9]+$') as is_apifootball
  from matches m
  join keyed kh on kh.team_id = m.home_team_id
  join keyed ka on ka.team_id = m.away_team_id
  where m.status = 'completed'
    and m.result in ('home', 'draw', 'away')
    and kh.k <> '' and ka.k <> ''
),
ranked as (
  select *, row_number() over (
    partition by home_key, away_key, kickoff_at::date
    order by is_apifootball desc, external_id
  ) as rk
  from base
)
select id, kickoff_at, result, league_id,
       home_key, away_key, home_name, away_name
from ranked
where rk = 1;
