-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260916095108, name 128_odds_had_no_index_on_the_column_every_reader_filters_on. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create index if not exists idx_odds_fetched_at
  on public.odds using btree (fetched_at);

do $$
declare
  have_idx boolean;
  plan     text;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'odds'
       and indexname = 'idx_odds_fetched_at'
  ) into have_idx;
  if not have_idx then
    raise exception '128: idx_odds_fetched_at was not created';
  end if;

  -- THE PLANNER MUST ACTUALLY PICK IT for the shape computeValues issues.
  -- An index that exists and is not chosen is the failure this migration
  -- would otherwise be signed off under. EXPLAIN cannot be read inside a DO
  -- block directly, so a temp function loops over its rows.
  create or replace function pg_temp.m128_plan() returns text language plpgsql as $f$
    declare r record; acc text := '';
    begin
      for r in execute $q$
        explain (format text)
        select id, match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at
          from public.odds
         where fetched_at >= now() - interval '24 hours'
         order by id asc
         limit 1000
      $q$ loop
        acc := acc || r."QUERY PLAN" || E'\n';
      end loop;
      return acc;
    end $f$;
  plan := pg_temp.m128_plan();
  if plan not like '%idx_odds_fetched_at%' then
    raise exception '128: planner does not use idx_odds_fetched_at for the 24h page:%', E'\n' || plan;
  end if;

  raise notice '128 ok — idx_odds_fetched_at created and chosen for the 24h page:%', E'\n' || plan;
end $$;
