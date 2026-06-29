'use strict';

/**
 * lib/dixonColes.js — Dixon-Coles bivariate goals model.
 *
 * A single coherent goals engine that prices 1X2, Over/Under (any line) and
 * BTTS from one pair of expected-goals values (λ home, μ away). Built around
 * the Dixon-Coles (1997) low-score dependency correction, which fixes the
 * independent-Poisson under-prediction of 0-0 / 1-0 / 0-1 / 1-1 scorelines.
 *
 * WHY MARKET-ANCHORED:
 *   The historical xG table doesn't cover the live World Cup teams (Swedish
 *   clubs etc. have zero rows), so fitting goals purely on history can't price
 *   the card. Instead we INVERT the bookmaker's own de-vigged 1X2 prices to
 *   recover the (λ, μ) the market is implying, then read every secondary market
 *   off that same distribution. The book can't disagree with itself on 1X2, so
 *   any edge we surface is a genuine cross-market inconsistency (its O/U or BTTS
 *   line drifting from what its own 1X2 implies), not a model fantasy.
 *
 * Pure functions, no I/O — unit-testable in isolation.
 *
 *   const { modelFromMarket } = require('./lib/dixonColes');
 *   const m = modelFromMarket({ homeOdds: 2.1, drawOdds: 3.4, awayOdds: 3.6 });
 *   m.pOver[2.5]   // model P(over 2.5) implied by the 1X2 prices
 *   m.bttsYes      // model P(both teams score)
 */

const DEFAULT_RHO       = -0.13;   // low-score correlation (Dixon-Coles 1997)
const DEFAULT_MAX_GOALS = 10;      // truncate the score matrix at 10-10

// ── Poisson pmf (log-space for numerical stability) ──────────────────────────
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(lambda) - lambda - logFact);
}

// ── Dixon-Coles low-score dependency correction τ(i, j) ──────────────────────
function tau(i, j, lambda, mu, rho) {
  if (i === 0 && j === 0) return 1 - lambda * mu * rho;
  if (i === 0 && j === 1) return 1 + lambda * rho;
  if (i === 1 && j === 0) return 1 + mu * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/**
 * Full normalised score-probability matrix M[i][j] = P(home i, away j).
 * The τ correction perturbs the four low-score cells, so we renormalise to
 * guarantee the matrix sums to 1.
 */
function scoreMatrix(lambda, mu, opts = {}) {
  const rho      = opts.rho      ?? DEFAULT_RHO;
  const maxGoals = opts.maxGoals ?? DEFAULT_MAX_GOALS;

  const homePmf = [];
  const awayPmf = [];
  for (let k = 0; k <= maxGoals; k++) { homePmf[k] = poissonPMF(k, lambda); awayPmf[k] = poissonPMF(k, mu); }

  const M = [];
  let sum = 0;
  for (let i = 0; i <= maxGoals; i++) {
    M[i] = [];
    for (let j = 0; j <= maxGoals; j++) {
      const p = Math.max(0, tau(i, j, lambda, mu, rho) * homePmf[i] * awayPmf[j]);
      M[i][j] = p;
      sum += p;
    }
  }
  if (sum > 0) for (let i = 0; i <= maxGoals; i++) for (let j = 0; j <= maxGoals; j++) M[i][j] /= sum;
  return M;
}

/**
 * Read market probabilities off a score matrix.
 * @param {number[][]} M
 * @param {number[]} totalsLines — O/U lines to evaluate (e.g. [2.5])
 * @returns {{pHome, pDraw, pAway, bttsYes, bttsNo, pOver:{[line]:p}, pUnder:{[line]:p}}}
 */
function marketsFromMatrix(M, totalsLines = [2.5]) {
  let pHome = 0, pDraw = 0, pAway = 0, bttsYes = 0;
  const pOver = {};
  for (const L of totalsLines) pOver[L] = 0;

  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      const p = M[i][j];
      if (i > j) pHome += p; else if (i === j) pDraw += p; else pAway += p;
      if (i >= 1 && j >= 1) bttsYes += p;
      for (const L of totalsLines) if (i + j > L) pOver[L] += p;
    }
  }

  const pUnder = {};
  for (const L of totalsLines) pUnder[L] = 1 - pOver[L];
  return { pHome, pDraw, pAway, bttsYes, bttsNo: 1 - bttsYes, pOver, pUnder };
}

// ── De-vig (remove bookmaker margin) ─────────────────────────────────────────
/**
 * Multiplicative (proportional) de-vig: normalise raw implied probabilities so
 * they sum to 1. Robust and parameter-free; good enough for cross-market work.
 */
function devig(impliedProbs) {
  const s = impliedProbs.reduce((a, b) => a + b, 0);
  return s > 0 ? impliedProbs.map(p => p / s) : impliedProbs;
}

/**
 * Invert de-vigged 1X2 probabilities to the (λ, μ) the market implies.
 *
 * Two free parameters, two independent constraints (1X2 has 2 d.o.f.), so the
 * solution is generally unique. We minimise squared error with a coarse-to-fine
 * grid search — smooth 2-D surface, no derivatives needed, ~1k matrix evals.
 *
 * If `anchorTotals` is supplied ({ line, pOver }) the fit also pins the total
 * to the market's O/U line, sharpening λ+μ where the 1X2 alone is ambiguous.
 *
 * @returns {{lambda, mu, err}}
 */
function fitGoalsTo1x2(pHome, pDraw, pAway, opts = {}) {
  const rho      = opts.rho      ?? DEFAULT_RHO;
  const maxGoals = opts.maxGoals ?? DEFAULT_MAX_GOALS;
  const anchor   = opts.anchorTotals ?? null;   // { line, pOver }
  const wTotals  = opts.totalsWeight ?? 1;

  const sse = (lam, mu) => {
    const lines = anchor ? [anchor.line] : [];
    const m = marketsFromMatrix(scoreMatrix(lam, mu, { rho, maxGoals }), lines);
    let e = (m.pHome - pHome) ** 2 + (m.pDraw - pDraw) ** 2 + (m.pAway - pAway) ** 2;
    if (anchor) e += wTotals * (m.pOver[anchor.line] - anchor.pOver) ** 2;
    return e;
  };

  let bestLam = 1.3, bestMu = 1.1, bestErr = Infinity;
  let lamLo = 0.15, lamHi = 4.0, muLo = 0.15, muHi = 4.0, step = 0.15;

  for (let pass = 0; pass < 4; pass++) {
    let lo = { lam: bestLam, mu: bestMu, err: Infinity };
    for (let lam = lamLo; lam <= lamHi + 1e-9; lam += step) {
      for (let mu = muLo; mu <= muHi + 1e-9; mu += step) {
        const e = sse(lam, mu);
        if (e < lo.err) lo = { lam, mu, err: e };
      }
    }
    bestLam = lo.lam; bestMu = lo.mu; bestErr = lo.err;
    lamLo = Math.max(0.05, bestLam - step); lamHi = bestLam + step;
    muLo  = Math.max(0.05, bestMu  - step); muHi  = bestMu  + step;
    step /= 8;
  }
  return { lambda: bestLam, mu: bestMu, err: bestErr };
}

/**
 * Full price sheet from (λ, μ): every market's model probability plus fair odds.
 */
function priceSheet(lambda, mu, opts = {}) {
  const totalsLines = opts.totalsLines ?? [2.5];
  const m = marketsFromMatrix(scoreMatrix(lambda, mu, opts), totalsLines);
  const fair = p => (p > 0 ? 1 / p : null);

  const fairOver = {}, fairUnder = {};
  for (const L of totalsLines) { fairOver[L] = fair(m.pOver[L]); fairUnder[L] = fair(m.pUnder[L]); }

  return {
    lambda, mu,
    expectedTotal: lambda + mu,
    supremacy:     lambda - mu,
    ...m,
    fair: {
      home: fair(m.pHome), draw: fair(m.pDraw), away: fair(m.pAway),
      bttsYes: fair(m.bttsYes), bttsNo: fair(m.bttsNo),
      over: fairOver, under: fairUnder,
    },
  };
}

/**
 * End-to-end: take a bookmaker's market odds → de-vig 1X2 → invert to (λ, μ)
 * → return the coherent price sheet for all markets, anchored (optionally) to
 * the book's own totals line.
 *
 * @param {{homeOdds, drawOdds, awayOdds, totalsLine?, overOdds?, underOdds?}} odds
 * @returns price sheet + { fitError, marketProbs }
 */
function modelFromMarket(odds, opts = {}) {
  const { homeOdds, drawOdds, awayOdds, totalsLine, overOdds, underOdds } = odds;
  if (!(homeOdds > 1) || !(drawOdds > 1) || !(awayOdds > 1)) {
    throw new Error('modelFromMarket: need valid 1X2 odds > 1');
  }

  const [pHome, pDraw, pAway] = devig([1 / homeOdds, 1 / drawOdds, 1 / awayOdds]);

  const fitOpts = { ...opts };
  const line = totalsLine ?? 2.5;
  if (overOdds > 1 && underOdds > 1) {
    const [pOver] = devig([1 / overOdds, 1 / underOdds]);
    fitOpts.anchorTotals = { line, pOver };
  }

  const { lambda, mu, err } = fitGoalsTo1x2(pHome, pDraw, pAway, fitOpts);
  const sheet = priceSheet(lambda, mu, { ...opts, totalsLines: [line] });
  return { ...sheet, fitError: err, marketProbs: { pHome, pDraw, pAway } };
}

module.exports = {
  DEFAULT_RHO, DEFAULT_MAX_GOALS,
  poissonPMF, tau, scoreMatrix, marketsFromMatrix,
  devig, fitGoalsTo1x2, priceSheet, modelFromMarket,
};
