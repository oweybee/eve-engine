/**
 * ensemble/inference.js — ML Ensemble Inference Wrapper
 *
 * Model dispatch priority order (highest to lowest):
 *
 *   1. SUPERMODEL_HALFTIME v2 (supermodel_halftime_v2.onnx)
 *      30-feature XGBoost (ELO + form + H2H + league + half-time state).
 *      Use: in-play / half-time signals only.
 *
 *   2. XGBOOST_PREMATCH (models/match_predictor.onnx)           ← NEW PRIMARY
 *      22-feature XGBoost trained on our own historical fixtures via
 *      bin/exportTrainingData.js + ml/train_xgboost.py.
 *      Input contract: float32[1,22] matching features.js FEATURE_COUNT.
 *      Output contract: float32[1,3] = [Home_Prob, Draw_Prob, Away_Prob].
 *      Use: pre-match value detection (primary model, deprecates Dixon-Coles).
 *
 *   3. SUPERMODEL_PREMATCH v2 (supermodel_prematch_v2.onnx)
 *      23-feature XGBoost (ELO + form + H2H + league OHE, no HT state).
 *      Falls back to v1 (18-dim) when v2 is absent.
 *
 *   4. ML_ENSEMBLE (match_odds.onnx + btts.onnx + over_under.onnx)
 *      Original 22-feature rolling-stats ensemble. Retained as fallback.
 *
 *   5. Dixon-Coles (deprecated — fallback only)
 *      Used ONLY when no ONNX model is available AND onnxruntime is absent.
 *      All code paths that reach Dixon-Coles emit a [DEPRECATED] log line.
 *
 * Session lifecycle:
 *   All sessions are loaded eagerly via initSessions() called once in run()
 *   before the withPool concurrency loop.  Subsequent calls within the pool
 *   hit the in-memory sessionCache with zero I/O.
 *
 * SUPERMODEL v2 FEATURE VECTOR
 * ─────────────────────────────
 * Halftime (30 dims) — see train_supermodel_v2.py:
 *   ELO       (3):  home_elo, away_elo, elo_differential
 *   Home form (7):  home_win_rate_10, home_draw_rate_10, home_goals_scored_10,
 *                   home_goals_conceded_10, home_sot_rate_10,
 *                   home_clean_sheet_rate_10, home_red_card_rate_10
 *   Away form (7):  same 7 for away team
 *   H2H       (1):  h2h_home_win_rate_5
 *   League OHE(5):  league_epl, league_laliga, league_bundesliga,
 *                   league_seriea, league_ligue1
 *   HT buckets(5):  ht_losing_2plus, ht_losing_1, ht_draw,
 *                   ht_winning_1, ht_winning_2plus
 *   HT cards  (2):  HR, AR
 *
 * Prematch (23 dims): ELO + Home form + Away form + H2H + League OHE
 *
 * XGBOOST_PREMATCH FEATURE VECTOR (22 dims, matches features.js exactly):
 *   home_xg_created_10,  home_xg_conceded_10,  home_ppda_10, home_sot_ratio_10,
 *   home_goals_scored_10, home_goals_conceded_10,
 *   home_xg_created_5,   home_xg_conceded_5,   home_ppda_5,  home_sot_ratio_5,
 *   away_xg_created_10,  away_xg_conceded_10,  away_ppda_10, away_sot_ratio_10,
 *   away_goals_scored_10, away_goals_conceded_10,
 *   away_xg_created_5,   away_xg_conceded_5,   away_ppda_5,  away_sot_ratio_5,
 *   rest_days_differential, is_neutral_venue
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// XGBoost match_predictor.onnx lives in engine/models/, siblings with the
// supermodel files in ensemble/models/.  This keeps the training pipeline's
// output path (models/) distinct from the legacy ensemble model directory.
const MODEL_DIR     = path.join(__dirname, 'models');
const ROOT_MODEL_DIR = path.join(__dirname, '..', 'models');

// Lazy-load onnxruntime-node only if installed (optional dependency).
let ort = null;
function getOrt() {
  if (ort) return ort;
  try {
    ort = require('onnxruntime-node');
  } catch {
    ort = null;
  }
  return ort;
}

// Immutable session cache — populated eagerly by initSessions() and never
// mutated after that point.  Reads from the pool loop are lock-free.
const sessionCache = {};

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Load a single ONNX model file into the session cache.
 * @param {string} name  - logical model name (no extension)
 * @param {string} [dir] - directory override (defaults to MODEL_DIR)
 * @returns {Promise<import('onnxruntime-node').InferenceSession|null>}
 */
async function loadSession(name, dir = MODEL_DIR) {
  if (sessionCache[name]) return sessionCache[name];
  const runtime = getOrt();
  if (!runtime) return null;

  const modelPath = path.join(dir, `${name}.onnx`);
  if (!fs.existsSync(modelPath)) return null;

  try {
    const session = await runtime.InferenceSession.create(modelPath, {
      // Prefer CPU (safe everywhere); set to 'cuda' for GPU inference.
      executionProviders: ['cpu'],
      // Disable inter-op parallelism — each match runs in its own pool slot,
      // so intra-slot threading is counter-productive.
      interOpNumThreads:  1,
      intraOpNumThreads:  1,
    });
    sessionCache[name] = session;
    return session;
  } catch (err) {
    console.warn(`[ensemble] failed to load ${name}.onnx:`, err.message);
    return null;
  }
}

/**
 * Eagerly pre-warm ALL known model sessions.
 * Call once at the start of run() — before the withPool loop — so that the
 * first inference call within the pool hits an already-initialised session
 * rather than paying the one-time ONNX graph initialisation cost mid-pool.
 *
 * @returns {Promise<void>}
 */
async function initSessions() {
  if (!getOrt()) {
    console.log('[ensemble] onnxruntime-node not installed — ONNX models unavailable.');
    return;
  }

  const candidates = [
    { name: 'match_predictor',         dir: ROOT_MODEL_DIR }, // XGBOOST_PREMATCH (primary)
    { name: 'supermodel_halftime_v2',  dir: MODEL_DIR },
    { name: 'supermodel_halftime',     dir: MODEL_DIR },
    { name: 'supermodel_prematch_v2',  dir: MODEL_DIR },
    { name: 'supermodel_prematch',     dir: MODEL_DIR },
    { name: 'match_odds',              dir: MODEL_DIR },
    { name: 'btts',                    dir: MODEL_DIR },
    { name: 'over_under',              dir: MODEL_DIR },
  ];

  const loaded = [];
  const missing = [];

  await Promise.all(
    candidates.map(async ({ name, dir }) => {
      const s = await loadSession(name, dir);
      if (s) loaded.push(name); else missing.push(name);
    }),
  );

  if (loaded.length) console.log(`[ensemble] sessions loaded: ${loaded.join(', ')}`);
  if (missing.length) console.log(`[ensemble] models absent (will skip): ${missing.join(', ')}`);
}

/**
 * Run ONNX inference for a single model.
 *
 * Handles two common ONNX output conventions:
 *   A) Named 'probabilities' output — raw float32 array  (our custom models)
 *   B) ZipMap sequence output       — [{0: p0, 1: p1, 2: p2}]  (skl2onnx default)
 *
 * @param {string}   modelName  - logical model name (no extension)
 * @param {number[]} features   - flat float32 feature vector
 * @param {string}   [dir]      - model directory override
 * @returns {Promise<number[] | null>}  probability array or null on failure
 */
async function runModel(modelName, features, dir = MODEL_DIR) {
  const session = await loadSession(modelName, dir);
  if (!session) return null;

  const runtime = getOrt();
  try {
    const inputName = session.inputNames[0];
    const tensor    = new runtime.Tensor(
      'float32',
      Float32Array.from(features),
      [1, features.length],
    );
    const results = await session.run({ [inputName]: tensor });

    // Convention A: output named 'probabilities' or similar — raw float32.
    const probKey = session.outputNames.find(n =>
      n.toLowerCase().includes('prob') ||
      n.toLowerCase().includes('output_probability')
    ) ?? session.outputNames[1] ?? session.outputNames[0];

    const output = results[probKey];
    if (!output) return null;

    // Convention B: skl2onnx zipmap=False → flat Float32Array [p0, p1, p2, ...]
    if (output.data instanceof Float32Array || output.data instanceof Float64Array) {
      return Array.from(output.data);
    }

    // Convention B (zipmap=True, legacy): sequence of {class: prob} maps
    if (Array.isArray(output.data) && output.data.length > 0) {
      const map = output.data[0];
      const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
      return keys.map(k => map[k]);
    }

    return null;
  } catch (err) {
    console.warn(`[ensemble] inference error (${modelName}):`, err.message);
    return null;
  }
}

// ── XGBoost pre-match model (PRIMARY) ────────────────────────────────────────

/**
 * Run the XGBoost pre-match classifier trained via ml/train_xgboost.py.
 *
 * This is the PRIMARY model for pre-match value detection, replacing the
 * legacy Dixon-Coles Poisson model.  It uses the identical 22-dimensional
 * feature vector produced by features.js, so no additional feature
 * engineering is required at inference time.
 *
 * Label encoding: 0=Home Win, 1=Draw, 2=Away Win.
 *
 * @param {number[]} features22  - 22-element float32 vector from features.js
 * @returns {Promise<{home: number, draw: number, away: number,
 *                    btts: null, over: null,
 *                    architecture: 'XGBOOST_PREMATCH'} | null>}
 */
async function xgboostPrematchInference(features22) {
  if (!features22 || features22.length !== 22) {
    console.warn('[ensemble] xgboostPrematchInference: expected 22 features, got', features22?.length);
    return null;
  }

  const probs = await runModel('match_predictor', features22, ROOT_MODEL_DIR);
  if (!probs || probs.length < 3) return null;

  // Normalise to guarantee sum-to-1 (calibration rounding may cause tiny drift)
  const sum = probs[0] + probs[1] + probs[2];
  if (sum <= 0 || !isFinite(sum)) return null;

  return {
    home:         probs[0] / sum,   // label 0 = Home Win
    draw:         probs[1] / sum,   // label 1 = Draw
    away:         probs[2] / sum,   // label 2 = Away Win
    btts:         null,             // XGBoost model is 1X2 only
    over:         null,
    architecture: 'XGBOOST_PREMATCH',
  };
}

/**
 * Run the supermodel (halftime) when in-play stats are available.
 * Label encoding: A=0, D=1, H=2 (alphabetical).
 * Prefers v2 (30-dim, leak-free) over v1 (26-dim) when both are present.
 *
 * @param {number[]} superFeatures - 30-dim (v2) or 26-dim (v1) feature vector
 * @returns {object|null}
 */
async function supermodelHalftimeInference(superFeatures) {
  // Try v2 first; fall back to v1 for backwards compatibility
  const v2Exists = fs.existsSync(path.join(MODEL_DIR, 'supermodel_halftime_v2.onnx'));
  const modelName = v2Exists ? 'supermodel_halftime_v2' : 'supermodel_halftime';
  const probs = await runModel(modelName, superFeatures);
  if (!probs || probs.length < 3) return null;

  return {
    away: probs[0],   // A=0
    draw: probs[1],   // D=1
    home: probs[2],   // H=2
    btts: null,
    over: null,
    architecture: 'SUPERMODEL_HALFTIME',
  };
}

/**
 * Run the supermodel (prematch) using pre-match features only.
 * Label encoding: A=0, D=1, H=2.
 * Prefers v2 (23-dim, with league OHE) over v1 (18-dim).
 *
 * @param {number[]} prematchFeatures - 23-dim (v2) or 18-dim (v1) feature vector
 * @returns {object|null}
 */
async function supermodelPrematchInference(prematchFeatures) {
  const v2Exists = fs.existsSync(path.join(MODEL_DIR, 'supermodel_prematch_v2.onnx'));
  const modelName = v2Exists ? 'supermodel_prematch_v2' : 'supermodel_prematch';
  const probs = await runModel(modelName, prematchFeatures);
  if (!probs || probs.length < 3) return null;

  return {
    away: probs[0],
    draw: probs[1],
    home: probs[2],
    btts: null,
    over: null,
    architecture: 'SUPERMODEL_PREMATCH',
  };
}

/**
 * Run the pre-match ensemble (match_odds + btts + over_under).
 *
 * @param {number[]} features      - 22-dim feature vector from features.js
 * @param {number}   completeness  - data completeness [0,1] from features.js
 * @param {number}   minCompleteness
 * @returns {object|null}
 */
async function ensembleInference(features, completeness, minCompleteness = 0.60) {
  if (completeness < minCompleteness) {
    console.log(`[ensemble] skipping — completeness ${(completeness * 100).toFixed(0)}% < threshold`);
    return null;
  }
  if (!fs.existsSync(MODEL_DIR)) return null;

  const [matchProbs, bttsProbs, ouProbs] = await Promise.all([
    runModel('match_odds',  features),
    runModel('btts',        features),
    runModel('over_under',  features),
  ]);

  if (!matchProbs || matchProbs.length < 3) return null;

  return {
    home: matchProbs[0],
    draw: matchProbs[1],
    away: matchProbs[2],
    btts: bttsProbs ? bttsProbs[1] : null,
    over: ouProbs   ? ouProbs[1]   : null,
    architecture: 'ML_ENSEMBLE',
  };
}

/**
 * Check whether any trained models are present and onnxruntime is installed.
 * Returns true even if only the XGBoost match_predictor.onnx is present —
 * that alone is sufficient to bypass Dixon-Coles for pre-match inference.
 */
function ensembleAvailable() {
  if (!getOrt()) return false;
  // Primary: new XGBoost model
  if (fs.existsSync(path.join(ROOT_MODEL_DIR, 'match_predictor.onnx'))) return true;
  // Legacy ensemble models
  const legacy = [
    'supermodel_halftime_v2', 'supermodel_halftime',
    'supermodel_prematch_v2', 'supermodel_prematch',
    'match_odds',
  ];
  return legacy.some(m => fs.existsSync(path.join(MODEL_DIR, `${m}.onnx`)));
}

module.exports = {
  // Session lifecycle
  initSessions,
  // Model inference functions (priority order)
  xgboostPrematchInference,      // PRIMARY — 22-feature XGBoost (match_predictor.onnx)
  supermodelHalftimeInference,   // in-play / half-time only
  supermodelPrematchInference,   // fallback pre-match (ELO + form + H2H + league OHE)
  ensembleInference,             // legacy 22-feature rolling-stats ensemble
  // Utilities
  ensembleAvailable,
};
