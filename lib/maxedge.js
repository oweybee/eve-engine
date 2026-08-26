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
 * WHAT THE TWO PROBABILITIES MEAN HERE. BOTH SIDES OF THE SUBTRACTION ARE
 * MARGIN-FREE. That is the whole rule, and it is the one this file got wrong
 * until 7 Aug 2026:
 *
 *     p_market = the Shin-de-vigged probability of this outcome, from the
 *                complete price vector the signal was detected against
 *     p_model  = (1 + edge) / detected_odds, our number, whoever produced it
 *
 * For a model architecture p_model is the model's probability, because
 * `edge = modelProb · odds − 1` by construction. For MARKET_ANCHORED it is the
 * Shin-de-vigged ANCHOR line, and the gap is then how far the bettable panel
 * sits from the sharp one — a market-vs-market claim, still non-zero, because
 * the two vectors are de-vigged from different books.
 *
 * THE BUG THIS REPLACES, AND WHY ITS SIGN WAS WRITTEN DOWN BACKWARDS. This
 * function used to set `p_market = 1 / detected_odds`, so `prob_gap` reduced to
 * exactly `detected_edge / detected_odds`. Verified across all 482 scored rows
 * in production on 7 Aug 2026: every one of them, across all seven
 * architectures, without exception.
 *
 * A raw `1/odds` vector SUMS TO MORE THAN ONE — 1.0348 on average across the
 * live 1X2 board, even taking the best price on every outcome across 15+ books.
 * So `1/odds` OVERSTATES each outcome's probability, which makes the market look
 * more likely than it is, which makes our disagreement look SMALLER. The gap was
 * too small and every score was therefore too LOW, not too high. Measured over
 * the 46 scored 1X2 selections live on 7 Aug: mean MXS 40.5 as shipped against
 * 51.7 de-vigged, and 3 rows clearing the 65 backing line where 8 would. The
 * note that shipped alongside the frontend mirror had this inverted — it said
 * scores were "inflated by roughly the vig" and that the fix would re-score
 * every row downward. It is the other way round, and the arithmetic is not
 * subtle: subtracting a smaller p_market yields a bigger gap.
 *
 * IT FAILS CLOSED. A caller that cannot supply a de-vigged market probability
 * gets nulls for the whole verdict, not a `1/odds` fallback. Two conventions in
 * one column with nothing saying which is which is precisely what `gap_basis`
 * exists to prevent, and a silent fallback would put them back.
 */

const { LABELS, BAND_MIN, bandFor, isBacked, THRESHOLDS } = require('./signalTier');

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
  // NIL. "We could not measure this" would have been written to the ledger as
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

/** The convention a row's `prob_gap` was measured under. Written to
 *  `value_signals.gap_basis` so the ledger never holds two silently mixed
 *  meanings. 'implied' is the pre-7-Aug-2026 rows only; nothing writes it. */
const GAP_BASIS = 'devigged';

/**
 * Everything migration 048's columns want, for one detected signal.
 *
 * Returns nulls for every field rather than throwing when the row cannot be
 * scored — an unscorable signal is still a signal, it just carries no verdict,
 * and the insert must not lose the row over it.
 *
 * `market_prob` is an INPUT and must be the de-vigged probability for this
 * outcome (see `devigMarketProb` in lib/marketAnchor.js). Without it there is no
 * score: no fallback to `1/odds`, because that is the defect, not a degraded
 * mode of it.
 *
 * @param {{detected_odds:number|string, detected_edge:number|string,
 *          model_architecture?:string|null, model_prob?:number|string|null,
 *          market_prob?:number|string|null}} row
 * @returns {{model_prob:number|null, market_prob:number|null, prob_gap:number|null,
 *           model_sigma:number|null, mxs:number|null, mxs_band:string|null,
 *           gap_basis:string|null}}
 */
/**
 * THE EDGE EFFICIENCY FACTOR — f(edge). Mirror of `edgeEfficiency` in
 * eve-frontend/lib/maxedge.ts, and it must stay a mirror: a score the engine
 * stores and a score the browser derives for the same row have to agree, and
 * the `MODEL_SIGMA` hand-copy is what happens when two copies of one number
 * drift (twice in production, neither threw).
 *
 * The raw score says how many error bars separate our number from the market.
 * It cannot say that a double-digit edge at a short price is usually a stale
 * line. The settled book can: odds 1.40-3.00, edge 4-10% returns +15.86% over
 * 141 bets and edge 10-20% returns -12.81% over 75. f(edge) prices that in.
 *
 *     edge <= 0%      0.50
 *     0 -> 4%         0.50 -> 1.00   linear
 *     4% -> 9%        1.00           the plateau
 *     9% -> 10%       1.00 -> 0.65   the knee
 *     10% -> 12%      0.65 -> 0.40   the stale-line shoulder
 *     edge > 12%      0.25           trap zone
 *
 * 65 / 0.65 = 100 and `maxedgeScore` caps the raw score at 99, so nothing above
 * a 10% edge can reach the PRIME line. That is why the knee is where it is.
 *
 * THE COST: the final score is no longer 100*(1 - 0.35^z) for any z, so it no
 * longer inverts to a count of error bars. `mxs_raw` is stored beside it so
 * that reading is not destroyed. Never average `mxs` across rows written on
 * different bases — `mes_basis` is what says which, the same rule `gap_basis`
 * already carries for the de-vig change.
 */
// YIELD-CALIBRATED, AND NO LONGER LOAD-BEARING FOR THE RUNG (26 Aug 2026).
//
// f(edge) used to be bent until the SCORE agreed with the box, because the
// score printed the word. `rungFor` in lib/signalTier.js prints it now, so this
// curve has one job left: keep the displayed NUMBER honest about which band a
// row sits in. No row changes RUNG because of this curve any more.
//
// THE THREE CLIFFS ARE DELIBERATE AND THEY SIT ON BOX BOUNDARIES — 0.75 -> 1.00
// at 5%, 1.00 -> 0.85 at 7%, 0.85 -> shoulder at 10%. A smooth curve would
// imply the bands shade into each other. They do not: they are different
// populations with different realised yields, and the box already cuts hard at
// exactly these three points.
//
// All three seams are DERIVED from signalTier rather than repeated. Typed
// twice, the floor and the plateau drifted within a day on 22 Aug and put a
// PRIME mark on a row every action declined.
const EDGE_EFFICIENCY = Object.freeze({
  rampTo:      THRESHOLDS.PRIME_EDGE_MIN,  // 0.40 -> 0.75 across the failing band
  rampFloor:   0.40,
  rampCeiling: 0.75,
  peakTo:      THRESHOLDS.PRIME_EDGE_MAX,  // f = 1.00 on [5%, 7%)
  edgeBandTo:  THRESHOLDS.EDGE_EDGE_MAX,   // f = 0.85 on [7%, 10%)
  edgeBand:    0.85,
  trapFrom:    0.12, shoulderEnd: 0.40,
  trap:        0.25,
});

function edgeEfficiency(edge) {
  // `Number(null)` IS 0 AND 0 IS FINITE, so a bare Number() here files an
  // UNKNOWN edge as a zero one and hands it the ramp floor — a penalty invented
  // for a caller that said nothing. That is the `Number(null)` family the
  // browser has an ESLint rule against and this repo does not; caught by
  // `f(edge) is a decay, never a boost` in engine.maxedge.test.js.
  if (edge === null || edge === undefined || edge === '') return 1;
  const e = Number(edge);
  if (!Number.isFinite(e)) return 1;
  const K = EDGE_EFFICIENCY;
  if (e <= 0)             return K.rampFloor;
  if (e <  K.rampTo)      return K.rampFloor + (e / K.rampTo) * (K.rampCeiling - K.rampFloor);
  if (e <  K.peakTo)      return 1;
  if (e <  K.edgeBandTo)  return K.edgeBand;
  if (e <  K.trapFrom) {
    const t = (e - K.edgeBandTo) / (K.trapFrom - K.edgeBandTo);
    return K.edgeBand - t * (K.edgeBand - K.shoulderEnd);
  }
  return K.trap;
}

/** Which definition of `mxs` a row was written under. Bumped when the meaning
 *  of the number changes, so history is never averaged across a redefinition —
 *  the rule `gap_basis` exists for. */
// Bumped 26 Aug 2026 because the MEANING of the number changed, not just its
// inputs — the rule 058 set for `gap_basis`. Rows written before this keep
// their old score and must never be averaged across the boundary.
const MES_BASIS = 'yield_calibrated';

function scoreSignal(row = {}) {
  const none = {
    model_prob: null, market_prob: null, prob_gap: null,
    model_sigma: null, mxs: null, mxs_raw: null, mes_efficiency: null,
    mes_basis: null, mxs_band: null, gap_basis: null,
  };

  const odds = Number(row.detected_odds);
  const edge = Number(row.detected_edge);
  if (!Number.isFinite(odds) || !Number.isFinite(edge) || !(odds > 1)) return none;

  // The de-vigged market probability, supplied by the caller that holds the
  // sibling prices. `Number(null)` is 0 and `Number('')` is 0 — both finite, and
  // both would sail past a bare isFinite check into a gap of p_model − 0, which
  // scores 99 on every row. Guard the range, not just the type.
  const marketProb = Number(row.market_prob);
  if (!Number.isFinite(marketProb) || !(marketProb > 0) || !(marketProb < 1)) return none;

  // Prefer a probability the caller actually holds; fall back to the identity
  // 048 backfills with. For every model architecture the two are the same
  // number, because edge = modelProb·odds − 1 by construction.
  const carried = Number(row.model_prob);
  const modelProb = Number.isFinite(carried) && carried > 0 ? carried : (1 + edge) / odds;

  const sigma = sigmaFor(row.model_architecture);
  const gap = modelProb - marketProb;
  const mxsRaw = sigma == null ? null : maxedgeScore(gap, sigma);
  // The band is cut from the FINAL score, which is the whole point: a stored
  // rung that disagreed with the stored number is the conflict this removes.
  const efficiency = edgeEfficiency(edge);
  const mxs = mxsRaw == null ? null : Math.round(mxsRaw * efficiency);

  // numeric(6,4) on both probability columns — round to fit rather than letting
  // Postgres reject the row for overflow on a 0.123456789.
  const p4 = v => Math.round(v * 1e4) / 1e4;

  return {
    model_prob:  p4(modelProb),
    market_prob: p4(marketProb),
    prob_gap:    Math.round(gap * 1e6) / 1e6,
    model_sigma: sigma,
    mxs,
    mxs_raw:     mxsRaw,
    mes_efficiency: efficiency,
    mes_basis:   MES_BASIS,
    mxs_band:    bandFor(mxs),
    // Stamped even when sigma is null and the score is not: the gap IS measured
    // and stored on those rows, so the column that says how it was measured has
    // to be there too.
    gap_basis:   GAP_BASIS,
  };
}

module.exports = {
  scoreSignal,
  maxedgeScore,
  edgeEfficiency,
  EDGE_EFFICIENCY,
  MES_BASIS,
  sigmaFor,
  MODEL_SIGMA,
  Z_GATE,
  BASE,
  GAP_BASIS,
  // Re-exported so a caller needs one require to score a row and read its rung.
  LABELS,
  BAND_MIN,
  bandFor,
  isBacked,
};
