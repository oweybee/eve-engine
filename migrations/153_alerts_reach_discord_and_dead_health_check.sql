-- 153 — alerts reach Discord, a dead health check retired, pinned search_path.
-- APPLIED 19 Oct 2026 via the Supabase MCP; this file is the record.
--
-- 1. alert_pipeline_health() posted `{"text": ...}`, Slack's shape. Discord
--    answers that with 400 and posts nothing, so even with a webhook set no
--    alert would ever have landed. It now sends `content` (Discord, capped at
--    1,900 chars under Discord's 2,000) and keeps `text` for Slack-style
--    receivers. engine_state.alert_webhook was also unset, so the 02:00
--    critical on 19 Oct went nowhere; it now points at #ops-alerts (set
--    outside this file: a webhook URL is a credential).
--    The one-an-hour throttle now counts only alerts actually SENT
--    (status 'critical'); a 'webhook missing' warn no longer swallows the next
--    real alert.
--
-- 2. credit_cap_plan read odds_api_daily_caps, last written 31 Aug and fed by
--    The Odds API, removed 11 Oct (PR #149). It could only ever say warn. It
--    goes the way uk_retail_books and quota_tracker went on 12 Oct.
--
-- 3. The 24 functions the security advisor flagged as role-mutable
--    search_path are pinned to `public, extensions`, which is what they
--    already resolved against under the default role path. No behaviour
--    change; a caller can no longer shadow a table they reference.
--
-- NOT CHANGED, ON PURPOSE, despite advisor findings:
--   - the nine SECURITY DEFINER views (v_best_prices, v_price_curve, ...):
--     owner decision of 8 Oct (migration 130) — they publish a derived figure
--     from a gated table and every one is read by the site.
--   - SECURITY DEFINER functions executable by anon: the board RPCs are the
--     site's read path, and the preview_*_ids() functions are called inside
--     the 047 tiered_read_* policies, so revoking EXECUTE would break RLS for
--     every visitor. They return ids of rows anon may already read.

create or replace function public.alert_pipeline_health()
returns integer
language plpgsql
set search_path = public, extensions
as $fn$
declare
  v_url   text;
  v_bad   text;
  v_count int;
  v_last  timestamptz;
  v_msg   text;
begin
  perform public.record_pipeline_health();

  select string_agg(format('%s: %s', component, detail), E'\n' order by component),
         count(*)
    into v_bad, v_count
  from public.check_pipeline_health()
  where status = 'critical';

  if v_count = 0 then return 0; end if;

  select max(observed_at) into v_last
  from public.pipeline_heartbeat
  where component = 'alert_sent' and status = 'critical' and observed_at > now() - interval '1 hour';
  if v_last is not null then return 0; end if;

  select value into v_url from public.engine_state where key = 'alert_webhook';

  if v_url is null or v_url = '' then
    insert into public.pipeline_heartbeat (component, status, metric, detail)
    values ('alert_sent','warn', v_count,
            'critical conditions present but engine_state.alert_webhook is not set; nothing was sent');
    return v_count;
  end if;

  v_msg := left(format(':rotating_light: MaxEdge pipeline: %s critical%s%s', v_count, E'\n', v_bad), 1900);

  perform net.http_post(
    url     := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := jsonb_build_object('content', v_msg, 'text', v_msg)
  );

  insert into public.pipeline_heartbeat (component, status, metric, detail)
  values ('alert_sent','critical', v_count, v_bad);
  return v_count;
end
$fn$;

create or replace function public.check_pipeline_health()
returns table(component text, status text, metric numeric, detail text)
language plpgsql
set search_path = public, extensions
as $fn$
declare
  v_odds_age_min numeric;
  v_stale_pct    numeric;
  v_warn_min     numeric;
  v_crit_min     numeric;
begin
  -- 12 Oct 2026: uk_retail_books and quota_tracker retired (The Odds API removed).
  -- 19 Oct 2026: credit_cap_plan retired for the same reason (migration 153).
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
end
$fn$;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proconfig is null
      and p.prokind = 'f'
      and p.proname in (
        'merge_duplicate_value_signal','performance_epoch','price_tier','price_max_age',
        'uk_retail_books','record_pipeline_health','estimate_refresh_credits',
        'reconcile_engine_runs','claim_selection_post','posted_selection_key',
        'claim_signal_post','release_signal_post','confirm_signal_post',
        'prime_post_books','prime_book_label','prime_floor_odds','prime_ko_label',
        'quote_for','predictor_entry_lock','mes_edge_efficiency','mes_raw','selection_label')
  loop
    execute format('alter function %s set search_path = public, extensions', r.sig);
  end loop;
end $$;
