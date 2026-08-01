'use strict';

/**
 * engine.supermodel.test.js — the learning model's editorial policy.
 *
 * The XGBoost supermodel ran on every cycle for months and published nothing:
 * its probabilities were written to computed_values.ensemble_*_prob and used
 * only for a "model certainty" readout. It now emits value_signals under
 * model_architecture = 'SUPERMODEL'.
 *
 * `supermodelEdge` is the whole policy for what an unproven forecast is allowed
 * to claim, so it is the thing worth pinning. Zero deps, no DB, no ONNX.
 */

const assert = require('assert');
const { supermodelEdge } = require('./computeValues');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

console.log('\nsupermodelEdge — what the learning model may publish');

test('prices EV against the best available odds', () => {
  // 40% on a 2.80 price → 0.40 × 2.80 − 1 = +0.12
  const { edge, publish } = supermodelEdge(0.40, 2.80);
  assert.strictEqual(edge, 0.12);
  assert.strictEqual(publish, true);
});

test('stays quiet below the threshold — that is rounding, not disagreement', () => {
  // 36% on 2.80 → +0.008, an eighth of a percent of EV.
  const { edge, publish, reason } = supermodelEdge(0.36, 2.80);
  assert.ok(edge > 0, 'the edge is still positive');
  assert.strictEqual(publish, false);
  assert.strictEqual(reason, 'below threshold');
});

test('holds itself to a HIGHER bar than the market consensus', () => {
  // The consensus publishes from 0.5% EV because it is market-anchored. A
  // forecast has no anchor, so the same edge must NOT publish here.
  const consensusWouldPublish = 0.006;
  const p = (1 + consensusWouldPublish) / 2.80;
  assert.strictEqual(supermodelEdge(p, 2.80).publish, false);
});

test('drops an implausible edge rather than publishing it', () => {
  // 90% on a 3.00 shot is not value, it is an out-of-distribution input.
  const { publish, reason } = supermodelEdge(0.90, 3.00);
  assert.strictEqual(publish, false);
  assert.strictEqual(reason, 'implausible');
});

test('a negative edge never publishes', () => {
  const { edge, publish } = supermodelEdge(0.30, 2.80);
  assert.ok(edge < 0);
  assert.strictEqual(publish, false);
});

test('missing inputs stay quiet instead of coercing to a number', () => {
  for (const [p, o, why] of [
    [null, 2.80, 'no probability'],
    [undefined, 2.80, 'no probability'],
    [0.40, null, 'no price'],
    [0.40, 1, 'no price'],       // odds of 1.00 cannot carry value
    [0, 2.80, 'no probability'], // a zero probability is not a reading
    [1.4, 2.80, 'no probability'],
  ]) {
    const r = supermodelEdge(p, o);
    assert.strictEqual(r.publish, false, `p=${p} odds=${o} must not publish`);
    assert.strictEqual(r.reason, why, `p=${p} odds=${o}`);
    assert.strictEqual(r.edge, null, 'no edge is computed from an unusable input');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
