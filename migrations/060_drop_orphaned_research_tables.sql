-- 060 — drop six orphaned research tables (≈114 MB, 26% of the database).
--
-- WHY THESE SIX AND NOT THE OTHER FIVE `research_*` TABLES
-- Every `research_*` relation was checked against three things on 9 Aug 2026:
--   1. every .js/.ts/.tsx/.py/.sql/.yml file in eve-engine AND eve-frontend
--   2. every function in the `public` schema (pg_get_functiondef regex)
--   3. every view/matview dependency (pg_rewrite → pg_depend)
--
-- These six matched NONE of the three. Nothing reads them and — the part that
-- makes them orphans rather than merely idle — nothing WRITES them either. They
-- are the residue of an ad-hoc SQL research session, with no producer left in
-- the repo and no consumer anywhere.
--
-- KEPT, because each one still has a live reader:
--   research_dc_preds      → refresh_disagreement_calibration(), lib/publication.*,
--                            lib/disagreement.ts, scripts/refreshDisagreement.js
--   research_match_ratings → research_build_pi_ratings()
--   research_team_ids      → research_build_pi_ratings(), research_fit_dc(), research_tune_pi()
--   research_dc_global     → research_fit_dc()
--   research_dc_params     → research_fit_dc()
--
-- REGENERATING THEM. The SQL that built these is NOT in the repo, so this drop
-- cannot be undone by re-running a script. What survives is everything they were
-- derived FROM: `match_results` (77,438 rows including the 56 MB `odds` corpus,
-- FTHG/FTAG/FTR), `research_match_ratings` and `research_team_ids`. All six are
-- rolling-window aggregates over that base, so they are re-derivable by
-- re-authoring the window queries — the shapes are recorded below precisely so
-- that is possible.
--
-- Row counts at drop time:
--   research_model_probs  53,604   60 MB    research_rolling      115,797  12 MB
--   research_disc_roll   115,800   13 MB    research_team_match   115,797  11 MB
--   research_disc_tm     115,800   13 MB    research_ref_roll      61,122  5.5 MB

/* ── SHAPES AT DROP TIME, for re-derivation ──────────────────────────────────

research_model_probs (53,604)   -- per-fixture model output vs the closing price
  id bigint, match_date date, div text, season text,
  fthg smallint, ftag smallint, ftr char, odds jsonb,
  lh double precision, la double precision,          -- fitted Poisson lambdas
  g_exp_gd numeric, home_played int, away_played int, roll_n bigint,
  p_home / p_draw / p_away / p_btts / p_under25 double precision

research_team_match (115,797)   -- one row per (match, team): shots base
  match_id bigint, match_date date, tid int, venue text, sf smallint, sa smallint

research_rolling (115,797)      -- rolling shots-on-target form over the above
  match_id bigint, tid int, venue text,
  roll_sot_for numeric, roll_sot_against numeric, roll_n bigint

research_disc_tm (115,800)      -- one row per (match, team): corners + cards base
  match_id bigint, match_date date, tid int, venue text,
  corners_for smallint, corners_against smallint,
  cards_own int, cards_match int, corners_match smallint

research_disc_roll (115,800)    -- rolling corners/cards form over the above
  match_id bigint, tid int, venue text,
  r_cf numeric, r_ca numeric, r_cards_own numeric, r_cards_match numeric, r_n bigint

research_ref_roll (61,122)      -- referee prior card rate at each match
  match_id bigint, referee text, ref_cards_prior numeric, ref_n bigint

─────────────────────────────────────────────────────────────────────────────── */

begin;

drop table if exists public.research_model_probs;
drop table if exists public.research_disc_roll;
drop table if exists public.research_disc_tm;
drop table if exists public.research_rolling;
drop table if exists public.research_team_match;
drop table if exists public.research_ref_roll;

-- Legacy tables that have been empty since inception and are referenced by
-- nothing in either repo or in any database function.
drop table if exists public.edge_signals;
drop table if exists public.team_stats;

-- Assert the survivors are still here — a typo above must not take a live
-- dependency with it.
do $$
begin
  perform 1 from public.research_dc_preds      limit 1;
  perform 1 from public.research_match_ratings limit 1;
  perform 1 from public.research_team_ids      limit 1;
  perform 1 from public.match_results          limit 1;
end $$;

commit;
