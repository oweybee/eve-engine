-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260903092441, name add_signal_health_check_view. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- One-row integrity check for the signal pipeline. Any non-zero count in the
-- alert columns means published output is at risk of showing stale fixtures.
create or replace view public.signal_health_check as
select
  (select count(*) from value_signals v join matches m on m.id = v.match_id
     where v.result = 'pending' and v.kickoff_at is distinct from m.kickoff_at)
    as pending_kickoff_drift,
  (select count(*) from value_signals v join matches m on m.id = v.match_id
     where v.kickoff_at is distinct from m.kickoff_at)
    as all_kickoff_drift,
  (select count(*) from promotable_value_signals)
    as live_candidates,
  (select count(*) from promotable_value_signals where match_kickoff_at < now())
    as phantom_candidates,
  (select count(*) from promotable_value_signals where mxs is null)
    as candidates_missing_score,
  (select count(*) from promotable_value_signals where mxs_band = 'PRIME')
    as prime_band_candidates,
  (select count(*) from matches
     where status = 'scheduled' and kickoff_at < now() - interval '6 hours')
    as played_but_scheduled,
  (select count(*) from value_signals v join matches m on m.id = v.match_id
     where v.result = 'pending' and m.kickoff_at < now() - interval '6 hours')
    as unsettled_after_kickoff,
  (select count(distinct coalesce(v.model_architecture, '(null)'))
     from value_signals v
     left join model_calibration mc
       on mc.model_architecture = coalesce(v.model_architecture, '')
     where mc.model_architecture is null)
    as models_without_calibration_row,
  (select max(detected_at) from value_signals)
    as last_signal_detected_at,
  round(extract(epoch from (now() - (select max(detected_at) from value_signals))) / 3600.0, 1)
    as hours_since_last_detection;

comment on view public.signal_health_check is
  'Daily integrity check for the signal pipeline. phantom_candidates and pending_kickoff_drift above zero mean the homepage free pick can show a stale or postponed fixture.';
