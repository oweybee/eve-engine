'use strict';

/**
 * lib/maxedge.js — the MaxEdgeScore, computed where the signal is detected.
 *
 * THE THIRD COPY OF ONE FORMULA, and that is deliberate rather than sloppy:
 *
 *   maxedge_score() / maxedge_band()   migration 048, in SQL
 *   maxedgeScore()  / maxedgeBand()    eve-frontend/lib/maxedge.ts
 *   this file                          the engine, at detection time
 *
 * There is no shared package between the three, the same arrangement
 * `publication` and `trackedLeagues` already live with. What keeps them honest
 * is that they are the same closed-form expression over the same seeded sigmas,
 * and that engine.maxedge.test.js checks this one against values taken from the
 * SQL. If you change the base, the gate or the cutoffs, change all three.
 *
 *     z   = (p_model − p_market) / sigma
 *     MXS = 100 × (1 − 0.35 ^ (z / z_gate))
 *
 * 65 is the selection boundary BY CONSTRUCTION: at z = z_gate the expression is
 * 1 − 0.35 = 0.65. Nothing chooses it.
 *
 * WHY THE ENGINE NEEDS IT AT ALL. Until 6 Aug 2026 nothing wrote `mxs`, so the
 * only MaxEdgeScores in the database were the ones migration 048 backfilled;
 * every row detected after that landed carried NULL. That is why the frontend
 * computed a rung from whatever score a surface happened to hold, and why the
 * broadcast could not name a rung at all. A score frozen at detection is also
 * more correct than one computed later: it is what the signal was actually
 * judged against, and the market has moved since.
 *
 * WHAT THE TWO PROBABILITIES MEAN HERE. Recovered exactly as migration 048's own
 * backfill recovers them, so the column keeps one meaning across backfilled and
 * newly-written rows:
 *
 *     p_market = 1 / detected_odds          what the BETTABLE price implies
 *     p_model  = (1 + edge) / detected_odds our number, whoever produced it
 *
 * For a model architecture that is the model's probability, because
 * `edge = modelProb · odds − 1` by construction. For MARKET_ANCHORED it is the
 * Shin-de-vigged fair line, and the gap is then how far the best price sits from
 * fair. `p_market` carries the bookmaker's margin, which overstates what the
 * market thinks and therefore UNDERSTATES the gap — conservative, which is the
 * right direction for a number that decides what we back.
 */

const { LABELS, BAND_MIN, bandFor, isBacked } = require('./signalTier');

/** The base. Chosen so that z = z_gate lands exactly on 65. */
const BASE = 0.35;

/**
 * Measured probability error per architecture, in probability units. A MIRROR of
 * the `model_calibration` table — read from production on 6 Aug 2026, not copied
 * from migration 048's seed, because the table has moved since: MARKET_ANCHORED
 * was added to it after 048 shipped and is not in that file.
 *
 * Keep in step with eve-frontend/lib/maxedge.ts MODEL_SIGMA. An architecture
 * missing here scores NULL, which is the safe direction — no score rather than a
 * score against an error bar nobody measured — but it is silent, so check the
 * table when you add a writer.
 */
const MODEL_SIGMA = {
  DIXON_COLES:      0.0300,  // floor — measured 0.00pp, unresolvable at n=77
  MARKET_ANCHORED:  0.0300,  // floor, n=0 — publishes by explicit owner decision
  MARKET_CONSENSUS: 0.0693,
  API_PREDICTIVE:   0.0530,
  CORNERS_MODEL:    0.0600,  // default, n=4
  CARDS_MODEL:      0.0600,  // default, n=2
};

/** Default z-gate. `model_calibration` seeds 1.0 for every architecture. */
const Z_GATE = 1.0;

/** Sigma for an architecture, or null when nobody has measured one. */
function sigmaFor(architecture) {
  const s = MODEL_SIGMA[architecture];
  return typeof s === 'number' && s > 0 ? s : null;
}

/**
 * MXS from a probability gap and the error bar it should be judged against.
 *
 * Returns null on any input that cannot produce an honest score, and 0 when our
 * number agrees with the price or likes the selection less than the price does.
 * Mirrors maxedge_score() including the 99 ceiling — 100 would require infinite
 * certainty, so it is unreachable by design rather than by clamping.
 */
function maxedgeScore(gap, sigma, zGate = Z_GATE) {
  // `Number(null)` is 0 and `Number('')` is 0, both finite — so an ABSENT gap
  // sailed past the guard below, hit `g <= 0` and scored a real 0, which is
  // NOISE. "We could not measure this" would have been written to the ledger as
  // "we measured it and found nothing". The SQL gets this right (`p_gap is
  // null` is checked first) and this did not, which is the two implementations
  // disagreeing on the one input that matters most. Caught by the golden test.
  const empty = v => v == null || v === '';
  if (empty(gap) || empty(sigma) || empty(zGate)) return null;
  const g = Number(gap), s = Number(sigma), z = Number(zGate);
  if (!Number.isFinite(g) || !Number.isFinite(s) || !(s > 0) || !(z > 0)) return null;
  if (g <= 0) return 0;
  const raw = 100 * (1 - Math.pow(BASE, g / (s * z)));
  return Math.min(99, Math.max(0, Math.round(raw)));
}

/**
 * Everything migration 048's columns want, for one detected signal.
 *
 * Returns nulls for every field rather than throwing when the row cannot be
 * scored — an unscorable signal is still a signal, it just carries no verdict,
 * and the insert must not lose the row over it.
 *
 * @param {{detected_odds:number|string, detected_edge:number|string,
 *          model_architecture?:string|null, model_prob?:number|string|null}} row
 * @returns {{model_prob:number|null, market_prob:number|null, prob_gap:number|null,
 *           model_sigma:number|null, mxs:number|null, mxs_band:string|null}}
 */
function scoreSignal(row = {}) {
  const none = {
    model_prob: null, market_prob: null, prob_gap: null,
    model_sigma: null, mxs: null, mxs_band: null,
  };

  const odds = Number(row.detected_odds);
  const edge = Number(row.detected_edge);
  if (!Number.isFinite(odds) || !Number.isFinite(edge) || !(odds > 1)) return none;

  const marketProb = 1 / odds;
  // Prefer a probability the caller actually holds; fall back to the identity
  // 048 backfills with. For every model architecture the two are the same
  // number, because edge = modelProb·odds − 1 by construction.
  const carried = Number(row.model_prob);
  const modelProb = Number.isFinite(carried) && carried > 0 ? carried : (1 + edge) / odds;

  const sigma = sigmaFor(row.model_architecture);
  const gap = modelProb - marketProb;
  const mxs = sigma == null ? null : maxedgeScore(gap, sigma);

  // numeric(6,4) on both probability columns — round to fit rather than letting
  // Postgres reject the row for overflow on a 0.123456789.
  const p4 = v => Math.round(v * 1e4) / 1e4;

  return {
    model_prob:  p4(modelProb),
    market_prob: p4(marketProb),
    prob_gap:    Math.round(gap * 1e6) / 1e6,
    model_sigma: sigma,
    mxs,
    mxs_band:    bandFor(mxs),
  };
}

module.exports = {
  scoreSignal,
  maxedgeScore,
  sigmaFor,
  MODEL_SIGMA,
  Z_GATE,
  BASE,
  // Re-exported so a caller needs one require to score a row and read its rung.
  LABELS,
  BAND_MIN,
  bandFor,
  isBacked,
};
