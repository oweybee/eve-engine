/**
 * ensemble/inference.js — ML Ensemble Inference Wrapper
 *
 * Three model tiers, used in priority order:
 *
 *   1. SUPERMODEL_HALFTIME v2 (supermodel_halftime_v2.onnx) — preferred
 *      30-feature XGBoost (leak-free, chronological validation).
 *      Falls back to v1 (26-feature) if v2 not present.
 *      Use: in-play/half-time betting signals.
 *
 *   2. ML_ENSEMBLE (match_odds.onnx + btts.onnx + over_under.onnx)
 *      22-feature pre-match ensemble from rolling xG/PPDA/goals stats.
 *      Use: pre-match value detection.
 *
 *   3. Dixon-Coles (fallback in computeValues.js)
 *      Used when models are absent or feature completeness is too low.
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
 *   NOTE: HST/AST removed (data leakage — full-match stats unavailable at HT)
 *
 * Prematch (23 dims): ELO + Home form + Away form + H2H + League OHE
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const MODEL_DIR = path.join(__dirname, 'models');

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

// Cache loaded sessions across calls (expensive to init on every match).
const sessionCache = {};

async function loadSession(name) {
  if (sessionCache[name]) return sessionCache[name];
  const runtime = getOrt();
  if (!runtime) return null;

  const modelPath = path.join(MODEL_DIR, `${name}.onnx`);
  if (!fs.existsSync(modelPath)) return null;

  try {
    const session = await runtime.InferenceSession.create(modelPath);
    sessionCache[name] = session;
    return session;
  } catch (err) {
    console.warn(`[ensemble] failed to load ${name}.onnx:`, err.message);
    return null;
  }
}

/**
 * Run ONNX inference for a single model.
 * @param {string} modelName  - 'match_odds' | 'btts' | 'over_under'
 * @param {number[]} features - flat float32 feature vector
 * @returns {number[] | null}  probability array or null on failure
 */
async function runModel(modelName, features) {
  const session = await loadSession(modelName);
  if (!session) return null;

  const runtime = getOrt();
  try {
    const inputName = session.inputNames[0];
    const tensor = new runtime.Tensor('float32', Float32Array.from(features), [1, features.length]);
    const results = await session.run({ [inputName]: tensor });

    // ONNX classifiers output probabilities under 'probabilities' or the first output name.
    const probKey = session.outputNames.find(n => n.includes('prob')) ?? session.outputNames[0];
    return Array.from(results[probKey].data);
  } catch (err) {
    console.warn(`[ensemble] inference error (${modelName}):`, err.message);
    return null;
  }
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
 */
function ensembleAvailable() {
  if (!getOrt()) return false;
  const models = ['supermodel_halftime_v2', 'supermodel_halftime',
                  'supermodel_prematch_v2', 'supermodel_prematch', 'match_odds'];
  return models.some(m => fs.existsSync(path.join(MODEL_DIR, `${m}.onnx`)));
}

module.exports = {
  ensembleInference,
  supermodelHalftimeInference,
  supermodelPrematchInference,
  ensembleAvailable,
};
