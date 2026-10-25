-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907230140, name 122_calibrate_health_thresholds. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 122: Calibrate the odds_writes threshold to the architecture in force.
--
-- Shipped at 45 minutes, which is right for the tiered queue but wrong for
-- the engine as it stands today: a flat ~3.1h sweep means a 63-minute-old
-- write is normal, so the check would have gone critical almost permanently.
-- An alert that is always on is an alert nobody reads, which is the same
-- disease as the cron log that always said success.
--
-- Threshold now comes from engine_state, so it can be tightened to 45 the
-- day the engine starts reading v_refresh_queue, without a code change.
-- =====================================================================

insert into public.engine_state (key, value, updated_at)
values ('health_odds_write_warn_minutes', '150', now())
on conflict (key) do nothing;

insert into public.engine_state (key, value, updated_at)
values ('health_odds_write_critical_minutes', '210', now())
on conflict (key) do nothing;

create or replace function public.check_pipeline_health()
returns table (component text, status text, metric numeric, detail text)
language plpgsql as $$
declare
  v_odds_age_min numeric;
  v_uk_age_h     numeric;
  v_stale_pct    numeric;
  v_cap_rows     int;
  v_quota_age_h  numeric;
  v_warn_min     numeric;
  v_crit_min     numeric;
begin
  select coalesce((select value::numeric from public.engine_state
                    where key='health_odds_write_warn_minutes'), 150) into v_warn_min;
  select coalesce((select value::numeric from public.engine_state
                    where key='health_odds_write_critical_minutes'), 210) into v_crit_min;

  select round(extract(epoch from (now()-max(fetched_at)))/60.0,1) into v_odds_age_min
  from public.odds where bookmaker <> 'apifootball_live';

  component := 'odds_writes'; metric := v_odds_age_min;
  status := case when v_odds_age_min is null or v_odds_age_min > v_crit_min then 'critical'
                 when v_odds_age_min > v_warn_min then 'warn' else 'ok' end;
  detail := format('last bookmaker write %s min ago (critical above %s)',
                   coalesce(v_odds_age_min::text,'never'), v_crit_min);
  return next;

  select round(extract(epoch from (now()-max(fetched_at)))/3600.0,1) into v_uk_age_h
  from public.odds where bookmaker = any(public.uk_retail_books());

  component := 'uk_retail_books'; metric := v_uk_age_h;
  status := case when v_uk_age_h is null or v_uk_age_h > 6 then 'critical'
                 when v_uk_age_h > 2 then 'warn' else 'ok' end;
  detail := format('last UK retail write %s h ago', coalesce(v_uk_age_h::text,'never'));
  return next;

  select round(100.0*count(*) filter (where not is_publishable)/nullif(count(*),0),1)
    into v_stale_pct
  from public.v_board_rows where freshness_tier in ('imminent','near');

  component := 'board_publishable'; metric := v_stale_pct;
  status := case when v_stale_pct is null then 'ok'
                 when v_stale_pct > 50 then 'critical'
                 when v_stale_pct > 20 then 'warn' else 'ok' end;
  detail := format('%s%% of imminent/near board rows fail the freshness gate',
                   coalesce(v_stale_pct::text,'n/a'));
  return next;

  select count(*) into v_cap_rows
  from public.odds_api_daily_caps where date >= current_date;

  component := 'credit_cap_plan'; metric := v_cap_rows;
  status := case when v_cap_rows = 0 then 'warn' else 'ok' end;
  detail := format('%s daily cap rows planned for today or later', v_cap_rows);
  return next;

  select round(extract(epoch from (now()-updated_at))/3600.0,1) into v_quota_age_h
  from public.engine_state where key='odds_api_quota';

  component := 'quota_tracker'; metric := v_quota_age_h;
  status := case when v_quota_age_h is null or v_quota_age_h > 24 then 'critical'
                 when v_quota_age_h > 6 then 'warn' else 'ok' end;
  detail := format('odds_api_quota last written %s h ago', coalesce(v_quota_age_h::text,'never'));
  return next;
end $$;

comment on function public.check_pipeline_health() is
  'Five outcome-based checks. odds_writes thresholds come from engine_state (health_odds_write_warn_minutes / _critical_minutes), currently 150/210 to match the engine flat ~3.1h sweep. TIGHTEN TO 45 once the engine reads v_refresh_queue, or the check will not catch a stall inside the tiered cadence.';

