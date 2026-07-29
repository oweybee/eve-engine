/**
 * engine.lambda.test.js — λ board inference tests.
 * Run: node engine.lambda.test.js
 */
'use strict';

const assert = require('assert');
const { clubKey, available, loadBundle, buildVector, priceFixture, segOf } =
  require('./lib/lambdaBoard');
const { mapLeague, summariseOdds } = require('./computeModelBoard');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { console.error(`  ✗ ${name}: ${err.message}`); process.exitCode = 1; });
}

(async () => {
  await test('clubKey normalization mirrors names.py', () => {
    assert.strictEqual(clubKey('Man City'), 'manchestercity');
    assert.strictEqual(clubKey('Manchester City'), 'manchestercity');
    assert.strictEqual(clubKey('Bayern Munich'), 'bayernmunchen');
    assert.strictEqual(clubKey('1. FC Köln'), clubKey('FC Koln'));
    assert.strictEqual(clubKey('West Ham'), 'westham');
    assert.strictEqual(clubKey("Nott'm Forest"), 'nottinghamforest');
  });

  await test('mapLeague routes production names to corpus slugs', () => {
    assert.strictEqual(mapLeague('Premier League'), 'epl');
    assert.strictEqual(mapLeague('Championship'), 'e1');
    assert.strictEqual(mapLeague('Serie A'), 'seriea');
    assert.strictEqual(mapLeague('Brazil Serie A'), 'brazil_seriea');
    assert.strictEqual(mapLeague('Austria Bundesliga'), 'austria_bundesliga');
    assert.strictEqual(mapLeague('Bundesliga'), 'bundesliga');
    assert.strictEqual(mapLeague('Some Unknown Cup'), null);
  });

  await test('summariseOdds: median + best per outcome', () => {
    const s = summariseOdds([
      { market: 'h2h', bookmaker: 'a', home_odds: 2.0, draw_odds: 3.4, away_odds: 3.6 },
      { market: 'h2h', bookmaker: 'b', home_odds: 2.1, draw_odds: 3.3, away_odds: 3.9 },
      { market: 'h2h', bookmaker: 'c', home_odds: 1.9, draw_odds: 3.5, away_odds: 3.7 },
      { market: 'totals', bookmaker: 'x', home_odds: 9, draw_odds: 9, away_odds: 9 },
    ]);
    assert.strictEqual(s.home.median, 2.0);
    assert.strictEqual(s.home.best.v, 2.1);
    assert.strictEqual(s.home.best.b, 'b');
    assert.strictEqual(s.away.best.v, 3.9);
    assert.strictEqual(s.home.n, 3);   // totals row excluded
  });

  await test('segOf boundaries', () => {
    assert.strictEqual(segOf(0.55), 'fav');
    assert.strictEqual(segOf(0.30), 'mid');
    assert.strictEqual(segOf(0.10), 'longshot');
  });

  if (!available()) {
    console.log('  (model artifacts absent — skipping bundle/ONNX tests)');
    return;
  }

  await test('bundle: feature contract complete + known club resolves', () => {
    const b = loadBundle();
    assert.ok(b.feature_order.length >= 15);
    assert.ok(Object.keys(b.clubs).length > 500);
    const { vec, matched } = buildVector(b, {
      homeName: 'Arsenal', awayName: 'Chelsea', leagueKey: 'epl',
      mp: [0.45, 0.27, 0.28],
    });
    assert.strictEqual(vec.length, b.feature_order.length);
    assert.ok(matched.home && matched.away, 'Arsenal/Chelsea must match bundle');
    assert.ok(vec.every(v => Number.isFinite(v)), 'vector must be finite');
  });

  await test('priceFixture end-to-end: sane probabilities + opportunities shape', async () => {
    const res = await priceFixture({
      homeName: 'Arsenal', awayName: 'Chelsea', leagueKey: 'epl',
      odds: { home: 2.05, draw: 3.6, away: 3.8 },
    });
    assert.ok(res, 'model available → result expected');
    const { sheet, lambdaHome, lambdaAway, opportunities } = res;
    assert.ok(lambdaHome > 0.2 && lambdaHome < 4, `λ_home sane (${lambdaHome})`);
    assert.ok(lambdaAway > 0.2 && lambdaAway < 4, `λ_away sane (${lambdaAway})`);
    const sum = sheet.pHome + sheet.pDraw + sheet.pAway;
    assert.ok(Math.abs(sum - 1) < 1e-6, `1X2 sums to 1 (${sum})`);
    for (const o of opportunities) {
      assert.ok(o.edge > 0 && o.edge <= 0.25);
      assert.ok(['fav', 'mid', 'longshot'].includes(o.seg));
      assert.ok(['proven', 'neutral', 'avoid'].includes(o.leagueTag));
    }
  });

  await test('model anchors to market: longshot flip prices home low', async () => {
    const res = await priceFixture({
      homeName: 'Arsenal', awayName: 'Chelsea', leagueKey: 'epl',
      odds: { home: 6.0, draw: 4.2, away: 1.55 },   // market says Arsenal big dog
    });
    assert.ok(res.sheet.pHome < 0.35, `market anchor must dominate (pHome=${res.sheet.pHome})`);
  });
})().then(() => {
  console.log(`\nlambda board tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
});
