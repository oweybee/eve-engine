'use strict';

/**
 * engine.dixoncoles.test.js — golden-vector tests for the Dixon-Coles goals
 * model. Zero deps, no DB / network.
 *
 * The SAME model is hand-ported into eve-frontend/lib/dixonColes.ts, and nothing
 * else keeps the two copies in sync — if one changes rho / MAX_GOALS / the fit,
 * the signals engine and the detail-page predictions silently disagree (audit
 * M19). These GOLDEN constants are duplicated verbatim in
 * eve-frontend/lib/dixonColes.test.js. If either port drifts, its test breaks.
 * When you INTENTIONALLY retune the model, update the goldens in BOTH repos.
 */

const assert = require('assert');
const dc = require('./lib/dixonColes');

// ── GOLDEN VECTORS (must match eve-frontend/lib/dixonColes.test.js) ──────────
const G = {
  poisson_2_1_5: 0.251021,
  scoreMatrix_1_4__1_1: { M00: 0.098518, M11: 0.142844, M21: 0.088488, sum: 1 },
  devig_2_1__3_4__3_6: [0.454343, 0.280624, 0.265033],
  fit: { lambda: 1.576758, mu: 1.160449 },
  markets: { pHome: 0.454376, pDraw: 0.280605, pAway: 0.265019, bttsYes: 0.560164, pOver25: 0.515445 },
};

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}
const close = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

console.log('\nDixon-Coles — constants');
test('rho and max goals are the tuned values', () => {
  assert.strictEqual(dc.DEFAULT_RHO, -0.13);
  assert.strictEqual(dc.DEFAULT_MAX_GOALS, 10);
});

console.log('\nDixon-Coles — golden vectors');
test('poissonPMF(2, 1.5)', () => close(dc.poissonPMF(2, 1.5), G.poisson_2_1_5));
test('scoreMatrix(1.4, 1.1) low-score cells + normalises to 1', () => {
  const M = dc.scoreMatrix(1.4, 1.1);
  let sum = 0; for (const row of M) for (const p of row) sum += p;
  close(M[0][0], G.scoreMatrix_1_4__1_1.M00);
  close(M[1][1], G.scoreMatrix_1_4__1_1.M11);
  close(M[2][1], G.scoreMatrix_1_4__1_1.M21);
  close(sum, G.scoreMatrix_1_4__1_1.sum, 1e-9);
});
test('devig([1/2.1, 1/3.4, 1/3.6]) sums to 1', () => {
  const dv = dc.devig([1 / 2.1, 1 / 3.4, 1 / 3.6]);
  close(dv[0], G.devig_2_1__3_4__3_6[0]);
  close(dv[1], G.devig_2_1__3_4__3_6[1]);
  close(dv[2], G.devig_2_1__3_4__3_6[2]);
  close(dv[0] + dv[1] + dv[2], 1, 1e-9);
});
test('fitGoalsTo1x2 recovers (λ, μ) from the de-vigged 1X2', () => {
  const dv = dc.devig([1 / 2.1, 1 / 3.4, 1 / 3.6]);
  const fit = dc.fitGoalsTo1x2(dv[0], dv[1], dv[2]);
  close(fit.lambda, G.fit.lambda);
  close(fit.mu, G.fit.mu);
});
test('marketsFromMatrix at the fitted (λ, μ) matches golden', () => {
  const mk = dc.marketsFromMatrix(dc.scoreMatrix(G.fit.lambda, G.fit.mu), [2.5]);
  close(mk.pHome, G.markets.pHome);
  close(mk.pDraw, G.markets.pDraw);
  close(mk.pAway, G.markets.pAway);
  close(mk.bttsYes, G.markets.bttsYes);
  close(mk.pOver[2.5], G.markets.pOver25);
});
test('modelFromMarket round-trips 1X2 back to (approximately) the input', () => {
  const s = dc.modelFromMarket({ homeOdds: 2.1, drawOdds: 3.4, awayOdds: 3.6 });
  // fitted 1X2 should reproduce the de-vigged inputs closely
  close(s.pHome, G.markets.pHome, 2e-3);
  close(s.pDraw, G.markets.pDraw, 2e-3);
  close(s.pAway, G.markets.pAway, 2e-3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
