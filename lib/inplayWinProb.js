'use strict';

/**
 * lib/inplayWinProb.js — in-play win-probability engine (Phase 1: pure maths).
 *
 * Competition-agnostic (works for internationals AND clubs) because it needs no
 * trained model and no half-time labels — it computes the live probability from
 * a pre-match goal model. See docs/INPLAY_WINPROB_DESIGN.md.
 *
 * Two steps:
 *   1. invertConsensusToLambda — recover full-match expected goals (λ_home,
 *      λ_away) from the de-vigged pre-match 1X2 (the market's own view).
 *   2. liveWinProb — given (λ_home, λ_away), the current score and the minute,
 *      the remaining goals are Poisson(λ · time-left); convolve with the current
 *      score to get P(home / draw / away) at any moment.
 *
 * Everything here is pure and deterministic (no I/O, no Date/Math.random), so it
 * is fully unit- and Monte-Carlo-tested (engine.winprob.test.js). DB wiring,
 * baseline capture and activation gating are later phases.
 */

const REG_MINUTES = 90;          // regulation length used for the time fraction
const GRID_K      = 12;          // max goals per side in the scoreline grid

/** Poisson pmf p(0..k; λ) via the stable recurrence p_k = p_{k-1}·λ/k. */
function poissonPmfArray(lambda, k = GRID_K) {
  const L = Math.max(0, lambda);
  const out = new Array(k + 1);
  out[0] = Math.exp(-L);
  for (let i = 1; i <= k; i++) out[i] = out[i - 1] * L / i;
  return out;
}

/**
 * 1X2 probabilities from independent-Poisson goal expectations.
 * @returns {{home:number, draw:number, away:number}} (normalised to sum 1)
 */
function outcomeProbsFromLambda(lambdaHome, lambdaAway, k = GRID_K) {
  const ph = poissonPmfArray(lambdaHome, k);
  const pa = poissonPmfArray(lambdaAway, k);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= k; i++) {
    for (let j = 0; j <= k; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
    }
  }
  const s = home + draw + away;
  return s > 0 ? { home: home / s, draw: draw / s, away: away / s } : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}

/**
 * Recover (λ_home, λ_away) whose Poisson 1X2 matches a target de-vigged 1X2.
 * Two free parameters, two independent target probs (draw follows) — solved by
 * successive grid refinement (deterministic, no calculus, robust to flat spots).
 *
 * @param {number} pHome @param {number} pDraw @param {number} pAway  fair probs
 * @returns {{lambdaHome:number, lambdaAway:number, err:number}}
 */
function invertConsensusToLambda(pHome, pDraw, pAway) {
  const s = pHome + pDraw + pAway;
  if (!(s > 0)) return { lambdaHome: 1.3, lambdaAway: 1.1, err: Infinity };
  const tH = pHome / s, tA = pAway / s;

  let loH = 0.02, hiH = 6, loA = 0.02, hiA = 6;
  let best = { err: Infinity, lh: 1.3, la: 1.1 };
  const N = 24;
  for (let pass = 0; pass < 5; pass++) {
    const stepH = (hiH - loH) / N, stepA = (hiA - loA) / N;
    for (let a = 0; a <= N; a++) {
      const lh = loH + a * stepH;
      for (let b = 0; b <= N; b++) {
        const la = loA + b * stepA;
        const o = outcomeProbsFromLambda(lh, la);
        const err = (o.home - tH) ** 2 + (o.away - tA) ** 2;
        if (err < best.err) best = { err, lh, la };
      }
    }
    // Re-centre the search window on the current best, one grid-cell each side.
    loH = Math.max(0.01, best.lh - stepH); hiH = best.lh + stepH;
    loA = Math.max(0.01, best.la - stepA); hiA = best.la + stepA;
  }
  return { lambdaHome: best.lh, lambdaAway: best.la, err: best.err };
}

/** Fraction of the match still to play at `minute` (ε-floored, clamped). */
function timeLeftFraction(minute, regMinutes = REG_MINUTES) {
  const rem = regMinutes - (Number(minute) || 0);
  if (rem <= 0) return 0;               // full time (or stoppage) → nothing left
  return Math.min(1, rem / regMinutes);
}

/**
 * Live win probability given the pre-match goal expectations, the current score
 * and the minute. Remaining goals ~ Poisson(λ · time-left); the final score is
 * (current + remaining), summed over the grid into 1X2 outcomes.
 *
 * @param {object} p
 * @param {number} p.lambdaHome  full-match expected goals, home
 * @param {number} p.lambdaAway  full-match expected goals, away
 * @param {number} p.homeGoals   current home goals
 * @param {number} p.awayGoals   current away goals
 * @param {number} p.minute      elapsed minutes (0 = pre-match, ≥90 = decided)
 * @returns {{home:number, draw:number, away:number}}
 */
function liveWinProb({ lambdaHome, lambdaAway, homeGoals = 0, awayGoals = 0, minute = 0 }) {
  const x = Math.max(0, Math.round(Number(homeGoals) || 0));
  const y = Math.max(0, Math.round(Number(awayGoals) || 0));
  const f = timeLeftFraction(minute);

  const ph = poissonPmfArray(lambdaHome * f);
  const pa = poissonPmfArray(lambdaAway * f);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      const p = ph[i] * pa[j];
      const fh = x + i, fa = y + j;
      if (fh > fa) home += p; else if (fh === fa) draw += p; else away += p;
    }
  }
  const s = home + draw + away;
  return s > 0 ? { home: home / s, draw: draw / s, away: away / s } : { home: 0, draw: 1, away: 0 };
}

/**
 * Convenience: pre-match λ (from the consensus 1X2) → live win probs in one call.
 */
function liveWinProbFromConsensus({ pHome, pDraw, pAway, homeGoals, awayGoals, minute }) {
  const { lambdaHome, lambdaAway } = invertConsensusToLambda(pHome, pDraw, pAway);
  return liveWinProb({ lambdaHome, lambdaAway, homeGoals, awayGoals, minute });
}

module.exports = {
  REG_MINUTES,
  GRID_K,
  poissonPmfArray,
  outcomeProbsFromLambda,
  invertConsensusToLambda,
  timeLeftFraction,
  liveWinProb,
  liveWinProbFromConsensus,
};
