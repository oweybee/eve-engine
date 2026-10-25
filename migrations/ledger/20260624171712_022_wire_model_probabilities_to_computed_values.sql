-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260624171712, name 022_wire_model_probabilities_to_computed_values. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- When the ML inference pipeline writes rows into model_probabilities,
-- automatically populate the ensemble_*_prob columns in computed_values
-- and flip model_architecture to ML_ENSEMBLE.

CREATE OR REPLACE FUNCTION sync_ensemble_probs_to_computed_values()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE computed_values
  SET
    ensemble_home_prob   = NEW.home_prob,
    ensemble_draw_prob   = NEW.draw_prob,
    ensemble_away_prob   = NEW.away_prob,
    model_architecture   = 'ML_ENSEMBLE'
  WHERE match_id = NEW.match_id;

  -- If no computed_values row yet, nothing to update — the engine will
  -- create the row when it runs computeEdge; the ensemble cols will be
  -- populated on the next upsert cycle via this trigger.
  RETURN NEW;
END;
$$;

-- Fire after INSERT or UPDATE on model_probabilities
DROP TRIGGER IF EXISTS trg_sync_ensemble_probs ON model_probabilities;
CREATE TRIGGER trg_sync_ensemble_probs
  AFTER INSERT OR UPDATE ON model_probabilities
  FOR EACH ROW
  EXECUTE FUNCTION sync_ensemble_probs_to_computed_values();

-- Also handle bulk backfill: sync any existing model_probabilities rows
-- (currently 0, but safe to run now so a future backfill is automatic)
UPDATE computed_values cv
SET
  ensemble_home_prob = mp.home_prob,
  ensemble_draw_prob = mp.draw_prob,
  ensemble_away_prob = mp.away_prob,
  model_architecture = 'ML_ENSEMBLE'
FROM model_probabilities mp
WHERE mp.match_id = cv.match_id;

