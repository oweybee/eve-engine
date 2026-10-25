-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907224840, name 112_pipeline_health_checks. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 112: Pipeline health, measured on WRITES not on dispatches.
--
-- cron.job_run_details recorded 1152 consecutive successes across the
-- 25-hour blackout of 6 Sep 2026, during which zero bookmaker rows were
-- written. It was telling the truth about the wrong thing: net.http_post
-- succeeds when the request leaves, and trigger-engine only dispatches to
-- GitHub and returns. Nothing in the chain asked whether a row landed.
--
-- Every check here reads the DATA. A check that reads the plumbing is how
-- an outage runs for a day on the busiest football day of the week.
-- =====================================================================

create table if not exists public.pipeline_heartbeat (
  id           bigserial primary key,
  observed_at  timestamptz not null default now(),
  component    text not null,
  status       text not null check (status in ('ok','warn','critical')),
  metric       numeric,
  detail       text
);

create index if not exists pipeline_heartbeat_recent
  on public.pipeline_heartbeat (component, observed_at desc);

comment on table public.pipeline_heartbeat is
  'Outcome-based health log. One row per component per check run. Written by check_pipeline_health() every 15 minutes. This is the table to look at when asking "is the engine actually working", because it counts rows written rather than requests sent.';

alter table public.pipeline_heartbeat enable row level security;

-- The UK high-street cohort: 17 books that stopped together at
-- 00:50:17 on 3 Sep 2026 and have written nothing since. These are the
-- books a UK bettor actually holds, so losing them is a product outage
-- even while other books keep writing.
create or replace function public.uk_retail_books()
returns text[] language sql immutable as $$
  select array[
    'paddypower','skybet','ladbrokes_uk','coral','betfred_uk','boylesports',
    'betway','sport888','virginbet','livescorebet','grosvenor','leovegas',
    'casumo','matchbook','smarkets','betfair_ex_uk','betano_uk'
  ];
$$;

create or replace function public.check_pipeline_health()
returns table (component text, status text, metric numeric, detail text)
language plpgsql as $$
declare
  v_odds_age_min   numeric;
  v_uk_age_h       numeric;
  v_stale_pct      numeric;
  v_cap_rows       int;
  v_quota_age_h    numeric;
begin
  -- 1. Are bookmaker prices being written at all?
  select round(extract(epoch from (now() - max(fetched_at)))/60.0, 1)
    into v_odds_age_min
  from public.odds where bookmaker <> 'apifootball_live';

  component := 'odds_writes';
  metric    := v_odds_age_min;
  status    := case when v_odds_age_min is null or v_odds_age_min > 45 then 'critical'
                    when v_odds_age_min > 25 then 'warn' else 'ok' end;
  detail    := format('last bookmaker write %s min ago', coalesce(v_odds_age_min::text,'never'));
  return next;

  -- 2. Are the UK retail books still reporting?
  select round(extract(epoch from (now() - max(fetched_at)))/3600.0, 1)
    into v_uk_age_h
  from public.odds where bookmaker = any(public.uk_retail_books());

  component := 'uk_retail_books';
  metric    := v_uk_age_h;
  status    := case when v_uk_age_h is null or v_uk_age_h > 6 then 'critical'
                    when v_uk_age_h > 2 then 'warn' else 'ok' end;
  detail    := format('last UK retail write %s h ago', coalesce(v_uk_age_h::text,'never'));
  return next;

  -- 3. Can the board actually show anything? Measured on the tiers that matter.
  select round(100.0 * count(*) filter (where not is_publishable) / nullif(count(*),0), 1)
    into v_stale_pct
  from public.v_board_rows where freshness_tier in ('imminent','near');

  component := 'board_publishable';
  metric    := v_stale_pct;
  status    := case when v_stale_pct is null then 'warn'
                    when v_stale_pct > 50 then 'critical'
                    when v_stale_pct > 20 then 'warn' else 'ok' end;
  detail    := format('%s%% of imminent/near board rows fail the freshness gate', coalesce(v_stale_pct::text,'n/a'));
  return next;

  -- 4. Did the credit planner run? It last produced a row for 31 Aug 2026.
  select count(*) into v_cap_rows
  from public.odds_api_daily_caps where date >= current_date;

  component := 'credit_cap_plan';
  metric    := v_cap_rows;
  status    := case when v_cap_rows = 0 then 'critical' else 'ok' end;
  detail    := format('%s daily cap rows planned for today or later', v_cap_rows);
  return next;

  -- 5. Is the quota tracker still being written? Last write 3 Sep 2026.
  select round(extract(epoch from (now() - updated_at))/3600.0, 1) into v_quota_age_h
  from public.engine_state where key = 'odds_api_quota';

  component := 'quota_tracker';
  metric    := v_quota_age_h;
  status    := case when v_quota_age_h is null or v_quota_age_h > 12 then 'critical'
                    when v_quota_age_h > 3 then 'warn' else 'ok' end;
  detail    := format('odds_api_quota last written %s h ago', coalesce(v_quota_age_h::text,'never'));
  return next;
end $$;

comment on function public.check_pipeline_health() is
  'Five outcome-based checks: bookmaker writes, UK retail coverage, board publishability, credit cap plan, quota tracker. Returns a row per component. record_pipeline_health() persists the result; the cron job calls that.';

create or replace function public.record_pipeline_health()
returns int language plpgsql as $$
declare n int;
begin
  insert into public.pipeline_heartbeat (component, status, metric, detail)
  select component, status, metric, detail from public.check_pipeline_health();
  get diagnostics n = row_count;

  -- keep 60 days
  delete from public.pipeline_heartbeat where observed_at < now() - interval '60 days';
  return n;
end $$;

