'use strict';

/**
 * engine.supermodel.test.js — THE LEARNING MODEL MAY NOT PUBLISH.
 *
 * This file used to test `supermodelEdge()`, the function that turned the
 * XGBoost forecast into an edge and wrote a value_signals row above a 3%
 * threshold. That function was DELETED on 6 Aug 2026 under the market-anchored
 * ruling, and this suite was rewritten to guard the deletion rather than to
 * test the thing.
 *
 * WHY IT WENT. `edge = modelProb · odds − 1` is a model generating a value flag
 * and an edge number, which rule 1 of the ruling forbids outright. The 3%
 * threshold was defended as a safeguard — "a forecast has no market anchor, so
 * it only speaks when it disagrees by an amount worth acting on" — and it was
 * the precise opposite. Over 44,820 settled selections, model-market
 * disagreement is anti-predictive: the market is closer to the truth 48.5% of
 * the time when the two agree, rising monotonically to 65.1% once they are 15pp
 * apart. A publisher gated on WIDE disagreement is therefore selecting for the
 * model's worst calls by construction. The bar was the mechanism, not the
 * brake.
 *
 * A test suite is the right place for this because the argument for putting it
 * back is genuinely appealing — the model is the most sophisticated thing in
 * the stack and it is now decorative. That is the intended state. If it is ever
 * to speak again it goes through paper_trade_gate() like everything else: 300
 * settled bets, CLV above +0.5%, z above 2. Yield never opens it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

const engine = require('./computeValues');
const SOURCE = fs.readFileSync(path.join(__dirname, 'computeValues.js'), 'utf8');

console.log('\nsupermodel — the model publisher stays deleted');

test('supermodelEdge is not exported', () => {
  assert.strictEqual(engine.supermodelEdge, undefined,
    'supermodelEdge was deleted under the market-anchored ruling — see computeValues.js');
});

test('no function computes an edge from a model probability', () => {
  // The shape, not the name: `p * odds - 1` where p is a forecast. Comments are
  // stripped first so the explanatory notes about the deletion do not trip it.
  const code = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/function\s+supermodelEdge/.test(code), 'supermodelEdge must not be redefined');
  assert.ok(!/_sm_\$\{outcome\}_edge|_sm_\w+_edge/.test(code),
    'the _sm_*_edge transport columns must not come back');
  assert.ok(!/SUPERMODEL_EV_THRESHOLD/.test(code),
    'a model-publishing threshold must not be reintroduced');
});

test("no value_signals insert carries the SUPERMODEL architecture", () => {
  const code = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/'SUPERMODEL'/.test(code),
    'nothing may write a signal under the SUPERMODEL architecture');
});

test('SUPERMODEL is still barred by the publication gate', () => {
  // Belt and braces: even if a row somehow appeared, it must not reach anyone.
  const { isPublished, withheldReason } = require('./lib/publication');
  assert.strictEqual(isPublished('SUPERMODEL'), false);
  assert.ok(withheldReason('SUPERMODEL').length > 0);
});

test('SUPERMODEL is model-derived, so it could never carry a score', () => {
  const { isMarketAnchored, unscoredReason } = require('./lib/edgeSource');
  assert.strictEqual(isMarketAnchored('SUPERMODEL'), false);
  assert.ok(/modelProb/.test(unscoredReason('SUPERMODEL')));
});

console.log('\nsupermodel — the probabilities are still written (display only)');

test('the ensemble block still fills model probability columns', () => {
  // Deleting the publisher must NOT have deleted the forecast. Rule 2 permits a
  // model probability beside the market's; it forbids one beside a price.
  assert.ok(/ensemble_home_prob/.test(SOURCE),
    'the display-only model probability columns must still be written');
});

console.log('\nmarket-anchored — the replacement path');

test('MARKET_ANCHORED is market-derived and may carry a score', () => {
  const { isMarketAnchored, unscoredReason } = require('./lib/edgeSource');
  assert.strictEqual(isMarketAnchored('MARKET_ANCHORED'), true);
  assert.strictEqual(unscoredReason('MARKET_ANCHORED'), '');
});

test('every model architecture is barred from scoring', () => {
  const { isMarketAnchored } = require('./lib/edgeSource');
  for (const arch of ['DIXON_COLES', 'API_PREDICTIVE', 'SUPERMODEL', 'LAMBDA_MC',
                      'SECOND_HALF_SNIPER', 'INPLAY_MODEL', 'CORNERS_MODEL', 'CARDS_MODEL']) {
    assert.strictEqual(isMarketAnchored(arch), false, `${arch} must not carry a score`);
  }
});

test('the edge-source gate fails closed on null and on the unknown', () => {
  const { isMarketAnchored } = require('./lib/edgeSource');
  assert.strictEqual(isMarketAnchored(null), false);
  assert.strictEqual(isMarketAnchored(undefined), false);
  assert.strictEqual(isMarketAnchored('SOMETHING_NEW'), false);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} supermodel: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
