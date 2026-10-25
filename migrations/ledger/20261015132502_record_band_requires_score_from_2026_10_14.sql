-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261015132502, name record_band_requires_score_from_2026_10_14. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- From fixtures kicking off 14 Oct 2026 onwards, a signal with no score (mxs IS NULL)
-- gets no record band, so it cannot appear on the Record as Prime/Edge/Longshot.
-- Earlier rows are deliberately left as they were.
DO $$
DECLARE
  v text;
  d text;
BEGIN
  FOREACH v IN ARRAY ARRAY['performance_signals','performance_signals_pending'] LOOP
    d := rtrim(pg_get_viewdef(format('public.%I', v)::regclass, true), E'; \n');
    IF position('( SELECT p.band_key' in d) = 0 OR position('LIMIT 1) AS band' in d) = 0 THEN
      RAISE EXCEPTION 'band expression not found in %', v;
    END IF;
    d := replace(d, '( SELECT p.band_key',
      'CASE WHEN vs.mxs IS NULL AND vs.kickoff_at >= ''2026-10-14 00:00:00+00''::timestamptz THEN NULL ELSE ( SELECT p.band_key');
    d := replace(d, 'LIMIT 1) AS band', 'LIMIT 1) END AS band');
    EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', v, d);
  END LOOP;
END $$;
