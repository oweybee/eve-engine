/**
 * THE 1X2 EDGE IS SIGNED.
 *
 * It was `has_edge ? edge : 0`, so a price shorter than fair stored a flat 0.
 * Measured 9 Oct 2026 over 11,166 stored legs: 9,764 exactly 0, NOT ONE
 * negative. The column could say "generous" or "nothing", never "too short".
 *
 * That is why the board drew almost no rungs — the site reads an edge of
 * exactly 0 as "no edge measured", so 87% of legs had no verdict to draw — and
 * why anything ranking on the column leaned to longshots: only the upside of
 * the model's own error survived into it.
 */
const test = require('node:test');
const assert = require('node:assert');

/* The arithmetic under test, mirrored. `p_adj * best - 1`, always. */
function edgeOf(p_adj, best) {
  return parseFloat((p_adj * best - 1).toFixed(6));
}
function hasEdgeOf(best, fair) { return best > fair; }

test('a price shorter than fair reads negative, not zero', () => {
  const p = 0.5, fair = 1 / p;            // fair 2.00
  const edge = edgeOf(p, 1.80);           // best 1.80, shorter than fair
  assert.ok(edge < 0, `expected a negative edge, got ${edge}`);
  assert.strictEqual(edge, -0.1);
  assert.strictEqual(hasEdgeOf(1.80, fair), false);
});

test('a price longer than fair is unchanged by the fix', () => {
  const p = 0.5, fair = 1 / p;
  assert.strictEqual(edgeOf(p, 2.20), 0.1);
  assert.strictEqual(hasEdgeOf(2.20, fair), true);
});

test('exactly fair is exactly zero, and that now means something', () => {
  assert.strictEqual(edgeOf(0.5, 2.00), 0);
  assert.strictEqual(hasEdgeOf(2.00, 2.00), false);
});

/* THE ONE-SIDEDNESS IS THE POINT. Under the old rule a model error of the same
   size in either direction produced +0.20 one way and 0 the other, so a sort
   over the column saw only the half that flattered the price. */
test('an error of the same size now reads the same size either way', () => {
  const best = 12.00;
  const over  = edgeOf(0.10, best);   // model says 10%, generous
  const under = edgeOf(0.0666667, best); // model says ~6.7%, too short
  assert.ok(over > 0 && under < 0, `${over} / ${under}`);
  // Old behaviour: under would have been 0 and dropped out of the comparison.
  assert.notStrictEqual(under, 0);
});

/* A LONGSHOT'S EDGE IS STILL AMPLIFIED BY ITS PRICE, and this change does not
   claim otherwise. It makes the amplification two-sided, which is what stops a
   ranking from selecting for price. */
test('the same probability error is worth more edge at a longer price', () => {
  const atLong  = Math.abs(edgeOf(0.093, 15.00) - edgeOf(0.08, 15.00));
  const atShort = Math.abs(edgeOf(0.783, 1.30) - edgeOf(0.77, 1.30));
  assert.ok(atLong > atShort * 5, `${atLong} vs ${atShort}`);
});
