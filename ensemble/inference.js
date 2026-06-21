/**
 * ensemble/inference.js — ML Ensemble Inference Wrapper
 *
 * Three model tiers, used in priority order:
 *
 *   1. SUPERMODEL_HALFTIME (supermodel_halftime.onnx)
 *      26-feature XGBoost trained on 34,519 matches. Requires half-time stats
 *      (HTHG, HTAG, HST, AST, HR, AR). ~65-70% accuracy.
 *      Use: in-play/half-time betting signals.
 *
 *   2. ML_ENSEMBLE (match_odds.onnx + btts.onnx + over_under.onnx)
 *      22-feature pre-match ensemble from rolling xG/PPDA/goals stats.
 *      ~50% accuracy (pre-match is fundamentally harder).
 *      Use: pre-match value detection.
 *
 *   3. Dixon-Coles (fallback in computeValues.js)
 *      Used when models are absent or feature completeness is too low.
 *
 * SUPERMODEL FEATURE VECTOR (26 dims) — see train_supermodel.py:
 *   Pre-match (18): home_elo, away_elo, elo_differential,
 *                   home/away win_rate_10, draw_rate_10, goals_scored_10,
 *                   goals_conceded_10, sot_rate_10, clean_sheet_rate_10,
 *                   red_card_rate_10, h2h_home_win_rate_5
 *   In-play  (8):  HTHG, HTAG, HST, AST, HR, AR, ht_lead, is_home_leading
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
 * Label encoding from train_supermodel.py: A=0, D=1, H=2 (alphabetical).
 *
 * @param {number[]} superFeatures - 26-dim vector (18 pre-match + 8 in-play)
 * @returns {object|null}
 */
async function supermodelHalftimeInference(superFeatures) {
  const probs = await runModel('supermodel_halftime', superFeatures);
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
 *
 * @param {number[]} prematchFeatures - 18-dim vector (pre-match only)
 * @returns {object|null}
 */
async function supermodelPrematchInference(prematchFeatures) {
  const probs = await runModel('supermodel_prematch', prematchFeatures);
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
  const models = ['supermodel_halftime', 'supermodel_prematch', 'match_odds'];
  return models.some(m => fs.existsSync(path.join(MODEL_DIR, `${m}.onnx`)));
}

module.exports = {
  ensembleInference,
  supermodelHalftimeInference,
  supermodelPrematchInference,
  ensembleAvailable,
};
