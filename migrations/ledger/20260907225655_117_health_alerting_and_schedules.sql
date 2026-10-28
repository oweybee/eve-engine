-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225655, name 117_health_alerting_and_schedules. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 117: Alerting on health, and the schedules that run it.
--
-- Alert transport is read from engine_state.alert_webhook so no secret
-- lives in a migration. Until that key is set the function records and
-- returns without sending, which is safe: the heartbeat table is still
-- written and is still the thing to look at.
-- =====================================================================

create or replace function public.alert_pipeline_health()
returns int language plpgsql as $$
declare
  v_url   text;
  v_bad   text;
  v_count int;
  v_last  timestamptz;
begin
  perform public.record_pipeline_health();

  select string_agg(format('%s: %s', component, detail), E'\n' order by component),
         count(*)
    into v_bad, v_count
  from public.check_pipeline_health()
  where status = 'critical';

  if v_count = 0 then return 0; end if;

  -- Do not re-alert more than once an hour for the same critical set.
  select max(observed_at) into v_last
  from public.pipeline_heartbeat
  where component = 'alert_sent' and observed_at > now() - interval '1 hour';
  if v_last is not null then return 0; end if;

  select value into v_url from public.engine_state where key = 'alert_webhook';

  if v_url is null or v_url = '' then
    insert into public.pipeline_heartbeat (component, status, metric, detail)
    values ('alert_sent','warn', v_count,
            'critical conditions present but engine_state.alert_webhook is not set; nothing was sent');
    return v_count;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := jsonb_build_object(
                 'text', format('MaxEdge pipeline: %s critical%s%s', v_count, E'\n', v_bad))
  );

  insert into public.pipeline_heartbeat (component, status, metric, detail)
  values ('alert_sent','critical', v_count, v_bad);
  return v_count;
end $$;

comment on function public.alert_pipeline_health() is
  'Records health, then posts to engine_state.alert_webhook if anything is critical, at most once an hour. Set that key to a Telegram or Slack webhook to receive alerts; until then criticals are still logged to pipeline_heartbeat.';

-- Schedules. Both write only to the new observability tables.
select cron.schedule('pipeline-health-15min',  '*/15 * * * *', $$select public.alert_pipeline_health()$$);
select cron.schedule('reconcile-engine-10min', '*/10 * * * *', $$select public.reconcile_engine_runs()$$);

