'use strict';

/**
 * engine.inplayopportunity.test.js — the two refusals that come before the edge.
 *
 * Both are derived from measurements recorded in lib/inplayOpportunity's
 * header, and both were written because the channel published rows nobody
 * should act on: a 1.090 shot on a 3-1 at the 82nd minute, and a 1.10 shot on a
 * match already decided. The header carries the reliability table; these pin
 * the behaviour so a later edit that "fixes" a quiet stage by moving a cap has
 * to fail a test with the reason attached.
 *
 * Run: node engine.inplayopportunity.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const o = require('./lib/inplayOpportunity');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const KO = '2026-08-26T19:00:00Z';
const at = mins => new Date(Date.parse(KO) + mins * 60_000);

console.log('the certainty cap — the model past its own resolution');
test('the cap is 0.85, the cut the measurement lands on', () => {
  assert.strictEqual(o.INPLAY_MAX_MODEL_PROB, 0.85);
});
test('the rows that prompted this are refused', () => {
  // Viking v Dinamo Zagreb, 3-1 at 57', priced 1.090: model said 0.9683.
  assert.strictEqual(o.isResolvableProbability(0.9683), false);
  // and the degenerate end, where the model says a result is impossible
  assert.strictEqual(o.isResolvableProbability(1), false);
  assert.strictEqual(o.isResolvableProbability(0.85001), false);
});
test('the calibrated range is untouched', () => {
  assert.strictEqual(o.isResolvableProbability(0.85), true);
  assert.strictEqual(o.isResolvableProbability(0.62), true);
  assert.strictEqual(o.isResolvableProbability(0.08), true);
});
test('it FAILS CLOSED — an absent probability is not a modest one', () => {
  // Number(null) is 0 and 0 is finite, which is exactly how this gets written.
  for (const bad of [null, undefined, '', NaN, 'abc', 0, -0.1]) {
    assert.strictEqual(o.isResolvableProbability(bad), false, `${String(bad)} must refuse`);
  }
});
test('a numeric string from PostgREST is read, not refused', () => {
  assert.strictEqual(o.isResolvableProbability('0.62'), true);
  assert.strictEqual(o.isResolvableProbability('0.97'), false);
});

console.log('the clock guard — the model prices time remaining');
test('ordinary second-half lag is PERMITTED', () => {
  // The observed shape: minute 65 read at 84 minutes past kickoff. 19 minutes
  // of lag, 15 of which is the break — 4 unexplained, well inside the cap.
  const v = o.clockIsBelievable({ minute: 65, kickoffAt: KO }, at(84));
  assert.strictEqual(v.ok, true);
  assert.ok(Math.abs(v.excess - 4) < 1e-9, `excess ${v.excess}`);
});
test('the first half gets NO break allowance', () => {
  const v = o.clockIsBelievable({ minute: 30, kickoffAt: KO }, at(32));
  assert.strictEqual(v.excess, 2);
  assert.strictEqual(v.ok, true);
});
test('a frozen clock is REFUSED, and says which guard', () => {
  // The measured failure: priced 115 minutes after kickoff, feed reading 70'.
  const v = o.clockIsBelievable({ minute: 70, kickoffAt: KO }, at(115));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'clock_stale');
  assert.strictEqual(v.excess, 30);
});
test('a clock AHEAD of the wall is refused — never observed, kept as a ratchet', () => {
  const v = o.clockIsBelievable({ minute: 60, kickoffAt: KO }, at(35));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'clock_ahead');
});
test('no kickoff FAILS OPEN and is distinguishable from a clean check', () => {
  const unknown = o.clockIsBelievable({ minute: 60, kickoffAt: null }, at(80));
  assert.strictEqual(unknown.ok, true);
  assert.strictEqual(unknown.reason, 'clock_unknown');
  assert.strictEqual(unknown.excess, null);
  const clean = o.clockIsBelievable({ minute: 60, kickoffAt: KO }, at(80));
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.reason, null,
    'a checked clock and an uncheckable one must not report the same thing');
});
test('an absent minute is uncheckable rather than stale', () => {
  const v = o.clockIsBelievable({ minute: null, kickoffAt: KO }, at(80));
  assert.strictEqual(v.reason, 'clock_unknown');
});
test('the boundary is exact — 20 passes, a hair over does not', () => {
  assert.strictEqual(o.clockIsBelievable({ minute: 60, kickoffAt: KO }, at(95)).ok, true);
  assert.strictEqual(o.clockIsBelievable({ minute: 60, kickoffAt: KO }, at(95.01)).ok, false);
});

console.log('the whole verdict, in the order the stage asks it');
test('the model is asked before the clock', () => {
  const v = o.opportunityVerdict({ pModel: 0.99, minute: 70, kickoffAt: KO }, at(115));
  assert.strictEqual(v.reason, 'model_saturated',
    'a saturated model is refused on its own account, not blamed on the clock');
});
test('a good row passes both', () => {
  const v = o.opportunityVerdict({ pModel: 0.62, minute: 65, kickoffAt: KO }, at(84));
  assert.deepStrictEqual({ ok: v.ok, reason: v.reason }, { ok: true, reason: null });
});
test('every refusal NAMES ITSELF — a quiet stage must not be one silence', () => {
  const reasons = new Set([
    o.opportunityVerdict({ pModel: 0.99, minute: 65, kickoffAt: KO }, at(84)).reason,
    o.opportunityVerdict({ pModel: 0.62, minute: 70, kickoffAt: KO }, at(115)).reason,
    o.opportunityVerdict({ pModel: 0.62, minute: 60, kickoffAt: KO }, at(35)).reason,
  ]);
  assert.deepStrictEqual([...reasons].sort(),
    ['clock_ahead', 'clock_stale', 'model_saturated']);
});

console.log('the caps are overridable without a deploy, like every in-play throttle');
test('a caller may pass its own caps', () => {
  assert.strictEqual(o.isResolvableProbability(0.95, 0.97), true);
  const v = o.clockIsBelievable({ minute: 60, kickoffAt: KO }, at(95), { maxExcess: 10 });
  assert.strictEqual(v.ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
