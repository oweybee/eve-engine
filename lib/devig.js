'use strict';

/**
 * lib/devig.js — TURNING QUOTED PRICES INTO PROBABILITIES.
 *
 * A bookmaker's quoted odds do not imply probabilities that sum to 1. The
 * excess — the overround, or vig — is the book's margin, and to recover what
 * the book actually believes you have to take it back out. HOW you take it out
 * is not a detail. It is a modelling assumption, and picking the wrong one
 * manufactures value that is not there.
 *
 * WHY SHIN AND NOT PROPORTIONAL. The multiplicative (proportional) method
 * divides every implied probability by the overround, which assumes the book
 * spreads its margin evenly across outcomes. Books do not. They load margin
 * onto outsiders, because that is where the uninformed money and the
 * favourite-longshot bias live. Divide a longshot's inflated implied
 * probability by a flat overround and you are left with a number that is still
 * too high — so when a soft book quotes that outcome a shade longer, the
 * comparison reports edge that exists only in the arithmetic.
 *
 * The 6 Aug 2026 backtest measured exactly this: of the selections flagged
 * under multiplicative de-vig, 49 were longshots, 1 won, and the set returned
 * -70% yield. That is not variance. That is a de-vig artifact.
 *
 * Shin (1992, 1993) derives the margin structure instead of assuming it. It
 * models the book as quoting against a population containing a fraction `z` of
 * insiders who know the outcome. The book must protect itself against them, and
 * the protection it needs is largest where an insider's payoff is largest — the
 * longest prices. Solving for the `z` that makes the recovered probabilities sum
 * to 1 gives back a margin distribution that is heavier on outsiders, which is
 * what books actually do. The longest price gets a LOWER probability than
 * proportional de-vig would give it. That is the entire point of using it.
 *
 * WHAT THIS FILE IS FOR. Per the architecture ruling of 6 Aug 2026, the market
 * — specifically Shin-de-vigged Pinnacle — is the sole source of fair value on
 * this platform, and no model output may generate a value flag, an edge number
 * or a MES score. This module is the first step of that path. It knows nothing
 * about models, and must stay that way: nothing here takes a forecast as input.
 *
 * MIRRORING. eve-engine is plain CommonJS — there is no TypeScript anywhere in
 * this repo and no build step, so this is `.js` and not `.ts`. The frontend
 * twin is eve-frontend/lib/devig.ts, which IS TypeScript because that repo is.
 * The two are hand-ported and share the golden vectors in their test files, the
 * same arrangement dixonColes.js / dixonColes.ts already uses. If you retune one,
 * retune both.
 */

/** Bisection tolerance on z. Well below any price granularity that exists. */
const Z_TOLERANCE = 1e-10;

/** Bisection iteration cap. 60 halvings of [0,1) reaches ~8.7e-19; the
 *  tolerance is hit long before this, so it is a safety stop, not a budget. */
const MAX_ITERATIONS = 200;

/** Below this overround, Shin's z is numerically indistinguishable from 0 and
 *  the closed form divides by (1 - z) → the proportional answer. We return the
 *  proportional answer directly rather than let it fall out of a fraction whose
 *  numerator and denominator are both racing to zero. */
const NEAR_ZERO_MARGIN = 1e-12;

/**
 * Coerce one quoted price. Deliberately NOT `Number(x)`: `Number(null)` is 0 and
 * `Number('')` is 0, and a zero that should have been "missing" is precisely the
 * failure this platform has shipped repeatedly. Anything that is not a finite
 * number strictly greater than 1 is missing, because a decimal price of 1.0 or
 * below is not a price.
 */
function toPrice(x) {
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = typeof x === 'number' ? x : (x == null ? NaN : Number(x));
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
}

/**
 * The result shape both methods return.
 *
 * @typedef {object} DevigResult
 * @property {number[]|null} probs      recovered probabilities, summing to 1, in
 *                                      input order; null if the market was not
 *                                      complete enough to de-vig.
 * @property {number}        overround  Σ(1/odds). 1.0 is a fair book, >1 has
 *                                      margin, <1 is arbitrage.
 * @property {number}        margin     overround - 1.
 * @property {number}        z          Shin's insider fraction. Always 0 for the
 *                                      multiplicative method.
 * @property {boolean}       arbitrage  true when overround <= 1 — the quoted
 *                                      prices are collectively beatable, so
 *                                      there is no margin to remove.
 * @property {string|null}   reason     why probs is null; null on success.
 * @property {string}        method     'shin' | 'multiplicative'
 */

/** Build the null result for an input we cannot price. */
function unpriceable(reason, method, overround = NaN) {
  return {
    probs: null,
    overround,
    margin: Number.isFinite(overround) ? overround - 1 : NaN,
    z: 0,
    arbitrage: false,
    reason,
    method,
  };
}

/**
 * Validate and normalise a set of quoted odds into implied probabilities.
 * Returns { pi, overround } or a reason string for rejection.
 */
function impliedFrom(odds) {
  if (!Array.isArray(odds)) return { error: 'odds must be an array' };
  if (odds.length < 2) return { error: 'a market needs at least two outcomes' };

  const prices = odds.map(toPrice);
  const missing = prices.filter(p => p === null).length;
  // A market is de-vigged as a COMPLETE set or not at all. De-vigging two legs
  // of a three-way book normalises the pair to 1 and silently prices the draw
  // at zero, which reads as a huge edge on both remaining outcomes.
  if (missing > 0) return { error: `incomplete market — ${missing} of ${odds.length} prices missing or invalid` };

  const pi = prices.map(p => 1 / p);
  const overround = pi.reduce((s, x) => s + x, 0);
  if (!Number.isFinite(overround) || overround <= 0) return { error: 'overround is not a positive finite number' };

  return { pi, overround };
}

/**
 * Proportional / multiplicative de-vig: p_i = π_i / Π.
 *
 * Kept exported and first-class NOT because it should be used for pricing — it
 * should not, see the header — but because the case against it is empirical and
 * has to stay reproducible. The Task 2 backtest and the devig test suite both
 * compare the two directly.
 *
 * @param {Array<number|string>} odds decimal prices for a complete market
 * @returns {DevigResult}
 */
function multiplicativeDevig(odds) {
  const imp = impliedFrom(odds);
  if (imp.error) return unpriceable(imp.error, 'multiplicative');
  const { pi, overround } = imp;

  return {
    probs: pi.map(x => x / overround),
    overround,
    margin: overround - 1,
    z: 0,
    // Normalising an arbitrage book still sums to 1 and is still the best
    // estimate available, so probs is populated — the flag is the warning.
    arbitrage: overround <= 1,
    reason: null,
    method: 'multiplicative',
  };
}

/**
 * Shin's recovered probability for one outcome.
 *
 *   p_i = ( sqrt( z² + 4(1-z)·π_i²/Π ) - z ) / ( 2(1-z) )
 *
 * Pulled out so the solver and the final evaluation cannot drift apart.
 */
function shinProb(piI, overround, z) {
  const disc = z * z + 4 * (1 - z) * (piI * piI) / overround;
  // disc is a sum of non-negative terms for z ∈ [0,1), so a negative value here
  // is floating-point dust at the boundary, not a real root problem.
  const root = Math.sqrt(Math.max(disc, 0));
  return (root - z) / (2 * (1 - z));
}

/**
 * Shin (1992) de-vig.
 *
 * Solves for z ∈ [0, 1) such that Σ p_i(z) = 1 by bisection. The sum is
 * monotonically decreasing in z on [0,1) for an overround book — at z=0 it
 * equals Π > 1, and it falls through 1 as z rises — so bisection is both safe
 * and, at 1e-10 on a bounded interval, entirely fast enough. There is a
 * closed-form for the 2-outcome case and Newton converges quicker in general,
 * but neither is worth the failure modes when this runs once per market.
 *
 * @param {Array<number|string>} odds decimal prices for a complete market
 * @returns {DevigResult}
 */
function shinDevig(odds) {
  const imp = impliedFrom(odds);
  if (imp.error) return unpriceable(imp.error, 'shin');
  const { pi, overround } = imp;

  // No margin to remove. Either the book is fair (Π = 1) or the prices are
  // collectively beatable (Π < 1), and in both cases Shin has no positive z to
  // find: the insider fraction that explains a non-existent margin is zero.
  // Normalise and flag. Callers must treat arbitrage as suspect data — across
  // this platform's books it has always been a stale or mispulled leg, never a
  // real arb — but the probabilities are still the best available estimate.
  if (overround <= 1 + NEAR_ZERO_MARGIN) {
    return {
      probs: pi.map(x => x / overround),
      overround,
      margin: overround - 1,
      z: 0,
      arbitrage: overround <= 1,
      reason: null,
      method: 'shin',
    };
  }

  const sumAt = z => pi.reduce((s, p) => s + shinProb(p, overround, z), 0);

  // Bracket. lo = 0 gives Σ = Π > 1. hi must give Σ < 1; z → 1 drives Σ → 0,
  // so 1 - 1e-12 brackets any real book. Walk hi up rather than assume it.
  let lo = 0;
  let hi = 1 - 1e-12;
  if (sumAt(hi) > 1) {
    // Unreachable for a genuine overround book. If a pathological input ever
    // gets here, say so instead of returning the last bisection midpoint as
    // though it solved anything.
    return unpriceable('no z in [0,1) satisfies the Shin constraint', 'shin', overround);
  }

  let z = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    z = (lo + hi) / 2;
    const s = sumAt(z);
    if (Math.abs(s - 1) < Z_TOLERANCE || (hi - lo) < Z_TOLERANCE) break;
    // Σ decreasing in z: overshooting 1 means z is too small.
    if (s > 1) lo = z; else hi = z;
  }

  const raw = pi.map(p => shinProb(p, overround, z));
  // Renormalise. Bisection lands the sum within Z_TOLERANCE of 1, not exactly
  // on it, and every caller downstream is entitled to assume a probability
  // vector sums to 1 — the residual is ~1e-11, far below any price granularity,
  // so this changes no decision and removes a class of drift bug.
  const total = raw.reduce((s, x) => s + x, 0);
  const probs = raw.map(x => x / total);

  return {
    probs,
    overround,
    margin: overround - 1,
    z,
    arbitrage: false,
    reason: null,
    method: 'shin',
  };
}

/**
 * Fair decimal price implied by a probability — the price at which a bet on it
 * breaks even. Convenience so callers do not scatter `1 / p` and its
 * divide-by-zero.
 */
function fairPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  return 1 / p;
}

module.exports = {
  shinDevig,
  multiplicativeDevig,
  fairPrice,
  // Exported for tests and for the Task 2 backtest, which needs to evaluate the
  // solver's residual directly rather than trust it.
  shinProb,
  toPrice,
  Z_TOLERANCE,
};
