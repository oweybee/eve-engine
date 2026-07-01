'use strict';

/**
 * engine.winprob.test.js — in-play win-probability maths (lib/inplayWinProb.js).
 * Run: node engine.winprob.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const wp = require('./lib/inplayWinProb');
const { winProbCandidates } = require('./computeInplayValues');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log('poissonPmfArray');
test('sums to ~1 for λ=1.4', () => {
  const p = wp.poissonPmfArray(1.4, 30);
  assert.ok(close(p.reduce((s, x) => s + x, 0), 1, 1e-6));
});
test('λ=0 → all mass on 0', () => {
  const p = wp.poissonPmfArray(0);
  assert.strictEqual(p[0], 1);
  assert.ok(close(p[1], 0));
});

console.log('outcomeProbsFromLambda');
test('probs sum to 1', () => {
  const o = wp.outcomeProbsFromLambda(1.6, 1.1);
  assert.ok(close(o.home + o.draw + o.away, 1, 1e-9));
});
test('equal λ → home == away by symmetry', () => {
  const o = wp.outcomeProbsFromLambda(1.3, 1.3);
  assert.ok(close(o.home, o.away, 1e-9));
});
test('higher home λ → home favoured', () => {
  const o = wp.outcomeProbsFromLambda(2.2, 0.8);
  assert.ok(o.home > o.away && o.home > o.draw);
});

console.log('invertConsensusToLambda (round-trip)');
for (const [lh, la] of [[1.6, 1.1], [2.2, 0.7], [0.9, 1.9], [1.3, 1.3]]) {
  test(`recovers λ=(${lh},${la}) from its own 1X2`, () => {
    const o = wp.outcomeProbsFromLambda(lh, la);
    const inv = wp.invertConsensusToLambda(o.home, o.draw, o.away);
    // Recovered λ reproduce the target 1X2 to high precision (λ itself can be
    // slightly off where the mapping is flat, so assert on the probabilities).
    const o2 = wp.outcomeProbsFromLambda(inv.lambdaHome, inv.lambdaAway);
    assert.ok(close(o2.home, o.home, 5e-3), `home ${o2.home} vs ${o.home}`);
    assert.ok(close(o2.away, o.away, 5e-3), `away ${o2.away} vs ${o.away}`);
  });
}
test('handles degenerate target', () => {
  const inv = wp.invertConsensusToLambda(0, 0, 0);
  assert.ok(Number.isFinite(inv.lambdaHome) && Number.isFinite(inv.lambdaAway));
});

console.log('timeLeftFraction');
test('minute 0 → 1', () => assert.ok(close(wp.timeLeftFraction(0), 1)));
test('minute 45 → 0.5', () => assert.ok(close(wp.timeLeftFraction(45), 0.5)));
test('minute 90 → 0', () => assert.strictEqual(wp.timeLeftFraction(90), 0));
test('stoppage (95) → 0, not negative', () => assert.strictEqual(wp.timeLeftFraction(95), 0));

console.log('liveWinProb — boundary cases');
test('minute 0, 0-0 equals the pre-match 1X2', () => {
  const pre = wp.outcomeProbsFromLambda(1.7, 1.0);
  const live = wp.liveWinProb({ lambdaHome: 1.7, lambdaAway: 1.0, homeGoals: 0, awayGoals: 0, minute: 0 });
  assert.ok(close(live.home, pre.home, 1e-9));
  assert.ok(close(live.away, pre.away, 1e-9));
});
test('full time 2-0 → home certain', () => {
  const live = wp.liveWinProb({ lambdaHome: 1.5, lambdaAway: 1.2, homeGoals: 2, awayGoals: 0, minute: 90 });
  assert.ok(close(live.home, 1, 1e-9) && close(live.draw, 0, 1e-9));
});
test('full time 1-1 → draw certain', () => {
  const live = wp.liveWinProb({ lambdaHome: 1.5, lambdaAway: 1.2, homeGoals: 1, awayGoals: 1, minute: 90 });
  assert.ok(close(live.draw, 1, 1e-9));
});
test('2-0 with 5 min left → home ≈ certain', () => {
  const live = wp.liveWinProb({ lambdaHome: 1.5, lambdaAway: 1.2, homeGoals: 2, awayGoals: 0, minute: 85 });
  assert.ok(live.home > 0.97, `home=${live.home}`);
});

console.log('liveWinProb — the England-v-Congo scenario');
test('strong favourite 0-1 down at 40\' still has real win equity but < pre-match', () => {
  // Pre-match: England big favourites (λ 2.2 vs 0.6).
  const pre = wp.outcomeProbsFromLambda(2.2, 0.6);
  const live = wp.liveWinProb({ lambdaHome: 2.2, lambdaAway: 0.6, homeGoals: 0, awayGoals: 1, minute: 40 });
  assert.ok(live.home < pre.home, 'win prob should drop after conceding');
  // ~28% here (needs a +2 swing in 50 min) — reduced but far from dead. Value
  // arises when the live market overreacts and prices the win even lower.
  assert.ok(live.home > 0.20, `favourite still live: home=${live.home.toFixed(3)}`);
  assert.ok(live.home < 0.45, `but not overstated: home=${live.home.toFixed(3)}`);
  assert.ok(close(live.home + live.draw + live.away, 1, 1e-9));
});

console.log('liveWinProb — Monte-Carlo cross-check (seeded)');
test('analytic ≈ simulated remainder within 1.5pp', () => {
  // Deterministic LCG so the test never flakes.
  let seed = 123456789;
  const rnd = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const poissonSample = (L) => { // Knuth
    const Lm = Math.exp(-L); let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > Lm);
    return k - 1;
  };
  const lambdaHome = 1.8, lambdaAway = 1.0, x = 1, y = 1, minute = 55;
  const f = wp.timeLeftFraction(minute);
  const N = 60000;
  let h = 0, d = 0, a = 0;
  for (let n = 0; n < N; n++) {
    const fh = x + poissonSample(lambdaHome * f);
    const fa = y + poissonSample(lambdaAway * f);
    if (fh > fa) h++; else if (fh === fa) d++; else a++;
  }
  const sim = { home: h / N, draw: d / N, away: a / N };
  const ana = wp.liveWinProb({ lambdaHome, lambdaAway, homeGoals: x, awayGoals: y, minute });
  assert.ok(Math.abs(sim.home - ana.home) < 0.015, `home sim ${sim.home.toFixed(3)} vs ana ${ana.home.toFixed(3)}`);
  assert.ok(Math.abs(sim.draw - ana.draw) < 0.015, `draw sim ${sim.draw.toFixed(3)} vs ana ${ana.draw.toFixed(3)}`);
  assert.ok(Math.abs(sim.away - ana.away) < 0.015, `away sim ${sim.away.toFixed(3)} vs ana ${ana.away.toFixed(3)}`);
});

console.log('liveWinProbFromConsensus (end-to-end)');
test('consensus → live, probs valid and consistent at KO', () => {
  const pre = wp.outcomeProbsFromLambda(2.0, 0.9);
  const atKO = wp.liveWinProbFromConsensus({ pHome: pre.home, pDraw: pre.draw, pAway: pre.away, homeGoals: 0, awayGoals: 0, minute: 0 });
  assert.ok(close(atKO.home + atKO.draw + atKO.away, 1, 1e-9));
  assert.ok(Math.abs(atKO.home - pre.home) < 5e-3, `KO home ${atKO.home} vs ${pre.home}`);
});

console.log('winProbCandidates (Stage 3 candidate builder)');
// England-style favourite, 0-1 down at 40' → model home ≈ 0.28. A live home
// price of 4.0 implies ~0.25, so backing it is +value.
const baseline = { lambda_home: 2.2, lambda_away: 0.6 };
const liveMatch = (over = {}) => ({
  id: 'm1', kickoff_at: '2026-07-01T16:00:00Z', goals_home: 0, goals_away: 1, minute: 40,
  home_team: { name: 'England' }, away_team: { name: 'Congo DR' },
  odds: [{ bookmaker: 'x', market: 'h2h', home_odds: 4.0, draw_odds: 3.4, away_odds: 1.9 }],
  ...over,
});
const opts = { evThreshold: 0.02, maxEdge: 0.20, minuteCap: 85 };

test('emits an INPLAY_DIXON_COLES home candidate when the live price beats the model', () => {
  const c = winProbCandidates(liveMatch(), baseline, opts);
  const home = c.find(x => x.outcome === 'home');
  assert.ok(home, 'home candidate present');
  assert.strictEqual(home.model_architecture, 'INPLAY_DIXON_COLES');
  assert.strictEqual(home.phase, 'inplay');
  assert.strictEqual(home.detected_odds, 4.0);
  assert.ok(home.detected_edge > 0.02 && home.detected_edge <= 0.20);
});
test('no baseline → no candidates', () => {
  assert.strictEqual(winProbCandidates(liveMatch(), null, opts).length, 0);
});
test('no live clock (minute null) → no candidates', () => {
  assert.strictEqual(winProbCandidates(liveMatch({ minute: null }), baseline, opts).length, 0);
});
test('past the minute cap → no candidates', () => {
  assert.strictEqual(winProbCandidates(liveMatch({ minute: 88 }), baseline, opts).length, 0);
});
test('short/no-edge price → no candidate for that outcome', () => {
  // home at 2.0 implies 0.5 >> model 0.28 → negative edge, filtered.
  const c = winProbCandidates(liveMatch({ odds: [{ bookmaker: 'x', market: 'h2h', home_odds: 2.0, draw_odds: 3.4, away_odds: 1.9 }] }), baseline, opts);
  assert.ok(!c.find(x => x.outcome === 'home'));
});
test('implausibly generous price is capped out (miscalibration guard)', () => {
  // home at 20.0 → edge ~4.6, above maxEdge → rejected.
  const c = winProbCandidates(liveMatch({ odds: [{ bookmaker: 'x', market: 'h2h', home_odds: 20.0, draw_odds: 3.4, away_odds: 1.9 }] }), baseline, opts);
  assert.ok(!c.find(x => x.outcome === 'home'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
