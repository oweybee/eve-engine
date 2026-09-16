-- ---------------------------------------------------------------------------
-- 128 — `odds` had no index on `fetched_at`, and every reader filters on it.
--
-- THE FINDING. The engine tick went red about twice an hour through 15-16 Sep
-- 2026 on one statement:
--
--     fetchMatchesForComputation[odds]: canceling statement due to statement
--     timeout
--
-- computeValues.js pages `odds` for the last 24 hours. `odds` carried two
-- indexes — the primary key and (match_id, fetched_at DESC) — so a filter on
-- `fetched_at` ALONE had nothing to seek on. The planner used the composite
-- index anyway and walked the whole of it, every page:
--
--     Index Scan using idx_odds_match_fetched on odds
--       Index Cond: (fetched_at >= (now() - '24:00:00'::interval))
--       rows=7346  Buffers: shared hit=3556 read=1225   868 ms   (one page, quiet)
--
-- 535,849 index entries read to return one day's 7,346 rows, then sorted, then
-- OFFSET into. pg_stat_statements for that query before this migration:
-- 506,046 calls, mean 249.8 ms, max 7,985.8 ms — and the API role
-- (`authenticator`) carries `statement_timeout = 8s`. Under any load the slow
-- tail crossed it. The cancellations were growing with the table: 23 on
-- 10 Sep, 94 on 14 Sep, on 8k-45k new rows a day.
--
-- IT WAS THE ONLY READER THAT FILTERS ON `fetched_at` ALONE, checked rather
-- than assumed. ingestOdds.prefetchLastOdds and captureSnapshot's prefetch
-- both filter on a `match_id` list first, so the planner drives them through
-- (match_id, fetched_at) — measured after this index: 85 matches over 48h in
-- 15.7 ms on the composite, this index untouched. Nothing else changes plan.
--
-- WHAT THIS DOES. One btree on (fetched_at). Not (fetched_at, id): the paging
-- orders by `id` after filtering, and a top-N sort over one day's rows costs
-- milliseconds, so the second column would buy nothing the sort does not.
-- The composite (match_id, fetched_at) stays — it is the right index for a
-- per-match latest-price lookup and that is what it is used for.
--
-- MEASURED AFTER APPLYING, same page, same quiet database:
--
--     Index Scan using idx_odds_fetched_at on odds   rows=7346
--       Buffers: shared hit=3425                       7.2 ms   (was 868 ms)
--     cursor page (`id > last`, migration's paired code change)  5.6 ms
--
-- Plain CREATE INDEX, not CONCURRENTLY: the table is 102 MB and the build
-- takes ~1-2 s, during which writers wait; the writers are the every-5-minute
-- ingest and the every-30s in-play worker, both of which retry on their next
-- tick. CONCURRENTLY cannot run inside the transaction this file is applied
-- in, and a two-second write pause is cheaper than a migration that has to be
-- applied by hand.
--
-- The paging change rides with it (lib/pagedRead.pageByKey, computeValues.js):
-- keyset on `id` rather than OFFSET, so each page sorts only what is still
-- ahead and a row inserted mid-walk cannot shift the offsets under the reader.
--
-- Reversible: drop index if exists public.idx_odds_fetched_at;
-- ---------------------------------------------------------------------------

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
