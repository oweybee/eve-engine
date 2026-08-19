'use strict';

/**
 * lib/eloProbs.js — Elo ratings to a 1X2 probability vector.
 *
 * `lib/elo.js` produces a TWO-WAY expectation: one number in (0,1) in which a
 * draw counts as a half. A football price has three outcomes, so the missing
 * piece is a draw model, and this file is that and nothing else.
 *
 * THE CONSTRUCTION, AND WHY IT IS THIS ONE.
 *
 *     d  = (eloHome + homeAdv) - eloAway        the effective rating gap
 *     E  = 1 / (1 + 10^(-d/400))                lib/elo.js expectedHome, verbatim
 *     pD = drawAtParity * exp(-(d / drawSpread)^2)
 *     pH = E - pD/2
 *     pA = 1 - E - pD/2
 *
 * The split is deliberately built so that `pH + pD/2 === E` EXACTLY. That means
 * the vector can never disagree with the Elo expectation it came from: the draw
 * model decides how much probability sits in the middle, never where the centre
 * of mass is. Any other construction lets a draw model quietly move the
 * favourite, and then two parts of the same forecast state different things.
 *
 * FITTED TO OUTCOMES, NEVER TO A PRICE. drawAtParity and drawSpread were fitted
 * by maximum likelihood on realised 1X2 results over 7,655 mature fixtures
 * (seasons 2019/20-2022/23), with no market input at any point. Fitting either
 * one to reduce disagreement with the market would make the model reproduce the
 * price by construction and destroy the only thing it could have been for. The
 * held-out seasons 2023/24-2025/26 reproduce the fit (Brier 0.2118 both sides),
 * so two parameters over 7,655 fixtures are not overfitting.
 *
 * PARAMETERS ARE DATA. `DEFAULTS` here is a PRE-FETCH FALLBACK, not the source
 * of truth: `goal_model_params` holds the fitted values and `loadEloParams()`
 * reads them. The sigma constants are why — a number hand-copied into a source
 * file disagrees with the table the moment either moves, and neither copy
 * throws when it does.
 *
 * homeAdv is NOT re-fitted here on purpose. K=30 / homeAdv=80 / default=1500 are
 * lib/elo.js constants mirroring ensemble/train_supermodel_v2.py, and `team_elo`
 * is built with them. A calibration has to describe the ladder that actually
 * runs, so this file inherits them rather than choosing its own.
 */

const { ELO_HOME_ADV, expectedHome } = require('./elo');

/**
 * Pre-fetch fallback ONLY. See the header — `goal_model_params` is the source
 * of truth and `loadEloParams()` is how a caller gets it.
 */
const DEFAULTS = Object.freeze({
  drawAtParity: 0.26,
  drawSpread:   400,
  homeAdv:      ELO_HOME_ADV,
});

/** A finite number or null. Not `Number(x)` — `Number(null)` is 0, and a 0
 *  rating is a 1500-point disagreement rather than a missing one. */
function finiteOrNull(x) {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * P(draw) at an effective rating gap of `d`.
 *
 * Clamped so `pH` and `pA` can never go negative: the raw curve can exceed
 * `2·min(E, 1-E)` at a large gap, where it would push the outsider's
 * probability below zero. The clamp binds only in lopsided fixtures and leaves
 * the identity `pH + pD/2 === E` intact.
 */
function drawProb(d, E, { drawAtParity, drawSpread }) {
  const raw = drawAtParity * Math.exp(-Math.pow(d / drawSpread, 2));
  const ceiling = 2 * Math.min(E, 1 - E) - 1e-6;
  return Math.max(0, Math.min(raw, ceiling));
}

/**
 * The 1X2 vector implied by a pair of Elo ratings.
 *
 * FAILS CLOSED. A missing rating returns null rather than falling back to 1500
 * for the absent side — a defaulted rating is not a forecast, it is the absence
 * of one wearing a number, and it would be scored as though it were a read.
 *
 * @param {number} eloHome pre-match rating of the home team
 * @param {number} eloAway pre-match rating of the away team
 * @param {{drawAtParity?:number, drawSpread?:number, homeAdv?:number}} [params]
 * @returns {{pHome:number, pDraw:number, pAway:number, gap:number}|null}
 */
function eloProbs(eloHome, eloAway, params = {}) {
  const h = finiteOrNull(eloHome);
  const a = finiteOrNull(eloAway);
  if (h == null || a == null) return null;

  const p = { ...DEFAULTS, ...params };
  if (!(p.drawSpread > 0)) return null;

  const gap = (h + p.homeAdv) - a;
  const E = expectedHome(h, a, p.homeAdv);
  const pDraw = drawProb(gap, E, p);
  const pHome = E - pDraw / 2;
  const pAway = 1 - E - pDraw / 2;

  // Guard the contract rather than trusting it. If any leg escapes (0,1) the
  // vector is not a probability and must not be handed on as one.
  if (!(pHome > 0 && pAway > 0 && pDraw >= 0)) return null;

  return { pHome, pDraw, pAway, gap };
}

/**
 * Fitted parameters from `goal_model_params`, falling back to DEFAULTS with a
 * warning. Never falls back SILENTLY: a run scoring against stale constants
 * should say so in the log, which is the failure lib/calibration.ts documents
 * on the frontend side.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function loadEloParams(supabase, { model = 'ELO_1X2', version = 'v1' } = {}) {
  const { data, error } = await supabase
    .from('goal_model_params')
    .select('param, value')
    .eq('model', model)
    .eq('version', version);

  if (error || !data?.length) {
    console.warn(`[eloProbs] no fitted params for ${model}/${version} `
      + `(${error?.message ?? 'no rows'}) — using compiled fallbacks`);
    return { ...DEFAULTS };
  }

  const by = new Map(data.map(r => [r.param, finiteOrNull(r.value)]));
  // The DB column name and the JS field name are different spellings of the
  // same parameter, so the absence check has to be made on the COLUMN. It was
  // made on the field, which no row is ever keyed by, so every parameter
  // reported a fallback it had not taken — including in the production fit run,
  // which warned three times while using the fitted values correctly. A warning
  // that cries wolf is worse than none: it trains a reader to skip the log.
  const COLUMN = { drawAtParity: 'draw_at_parity', drawSpread: 'draw_spread', homeAdv: 'home_adv' };
  const out = {
    drawAtParity: by.get(COLUMN.drawAtParity) ?? DEFAULTS.drawAtParity,
    drawSpread:   by.get(COLUMN.drawSpread)   ?? DEFAULTS.drawSpread,
    homeAdv:      by.get(COLUMN.homeAdv)      ?? DEFAULTS.homeAdv,
  };
  for (const k of Object.keys(out)) {
    if (by.get(COLUMN[k]) == null) console.warn(`[eloProbs] ${k} fell back to the compiled value`);
  }
  return out;
}

module.exports = { DEFAULTS, eloProbs, drawProb, loadEloParams };
