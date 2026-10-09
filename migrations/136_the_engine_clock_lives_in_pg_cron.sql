-- 136 - the engine clock lives in pg_cron, and now it lives in the repo too
--
-- ── WHAT WAS FOUND ON 9 OCT 2026 ─────────────────────────────────────────────
--
-- The 7 Oct state-of-play asked who dispatches engine.yml every 5 minutes as
-- `oweybee`, "not in eve-engine and not in eve-frontend". It is this:
--
--   cron.job 2  trigger-engine-every-5min   */5 * * * *
--     -> net.http_post(.../functions/v1/trigger-engine)
--       -> POST /repos/oweybee/eve-engine/actions/workflows/engine.yml/dispatches
--
-- Neither the job nor the edge function was in any repo. There were three
-- clocks on the engine:
--
--   pg_cron job 2           every 5 min    the one actually doing the work
--   engine.yml `schedule`   */20           1 of 59 runs on 9 Oct, displaced
--   run-engine.yml          */15           disabled_manually since 25 Jun
--
-- Same commit: the `schedule:` is removed from engine.yml, run-engine.yml is
-- deleted, and the edge function source is committed under
-- supabase/functions/trigger-engine.
--
-- ── WHY 5 MINUTES IS KEPT ─────────────────────────────────────────────────────
--
-- The job takes 8 to 14 minutes and the concurrency group keeps one pending,
-- so 5-minute dispatch means back-to-back runs, ~7 an hour, with about 4 in 10
-- dispatches displaced before they start. That is continuous polling, which
-- the closing tier (5-minute plan interval) needs. API-Football spend is set
-- by engine_plan, the Odds API by its daily ceiling, and Actions minutes are
-- free on a public repo. So the cadence is deliberate; it just was not written
-- down anywhere.
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────
--
-- Pins the schedule and active flag of the existing job. It does NOT recreate
-- the job, because the command carries a bearer token and this repo is public.
-- The token is the ANON key (checked: role=anon), so it is not a secret, but it
-- does mean anyone holding the anon key can call trigger-engine and start a
-- run. The cost ceiling above bounds that; adding a shared-secret header check
-- to the function is the follow-up if it is ever abused.
--
-- To change the cadence, write a new migration that alters this job. Do not
-- add a `schedule:` back to engine.yml.

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'trigger-engine-every-5min';
  if v_jobid is null then
    raise exception
      'cron job trigger-engine-every-5min is missing. Recreate it with '
      'cron.schedule(''trigger-engine-every-5min'', ''*/5 * * * *'', '
      '$c$select net.http_post(url := ''<project>/functions/v1/trigger-engine'', '
      'headers := jsonb_build_object(''Authorization'', ''Bearer <anon key>'', '
      '''Content-Type'', ''application/json''), body := ''{}''::jsonb)$c$) '
      'and re-run this migration.';
  end if;

  perform cron.alter_job(job_id := v_jobid, schedule := '*/5 * * * *', active := true);
end $$;
