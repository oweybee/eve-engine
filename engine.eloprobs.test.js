'use strict';

/**
 * engine.eloprobs.test.js — Elo ratings to a 1X2 vector.
 *
 * The property that matters is the IDENTITY: pHome + pDraw/2 must equal the Elo
 * expectation exactly. If it ever drifts, the draw model has started moving the
 * favourite and two halves of one forecast are saying different things.
 */

const assert = require('assert');
const { eloProbs, drawProb, DEFAULTS } = require('./lib/eloProbs');
const { expectedHome, ELO_HOME_ADV } = require('./lib/elo');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('\nelo → 1X2');

test('the vector always sums to exactly 1', () => {
  for (let h = 1200; h <= 1900; h += 50) {
    for (let a = 1200; a <= 1900; a += 50) {
      const p = eloProbs(h, a);
      assert.ok(p, `${h} v ${a} returned null`);
      assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) < 1e-12,
        `${h} v ${a} summed to ${p.pHome + p.pDraw + p.pAway}`);
    }
  }
});

test('pHome + pDraw/2 equals the Elo expectation EXACTLY', () => {
  // The whole construction. A draw model may decide how much sits in the
  // middle; it may never move the centre of mass.
  let worst = 0;
  for (let h = 1200; h <= 1900; h += 25) {
    for (let a = 1200; a <= 1900; a += 25) {
      const p = eloProbs(h, a);
      const E = expectedHome(h, a, ELO_HOME_ADV);
      worst = Math.max(worst, Math.abs(p.pHome + p.pDraw / 2 - E));
    }
  }
  assert.ok(worst < 1e-12, `worst deviation ${worst}`);
});

test('no leg is ever negative, even at the widest gap in the corpus', () => {
  // Ratings ran 1226–1922 over the replayed history, so this is the real range
  // plus headroom. The raw draw curve exceeds 2·min(E,1−E) out here and the
  // clamp is what stops the outsider going below zero.
  for (const [h, a] of [[1922, 1226], [1226, 1922], [2200, 1000], [1000, 2200]]) {
    const p = eloProbs(h, a);
    assert.ok(p, `${h} v ${a} returned null`);
    assert.ok(p.pHome > 0 && p.pAway > 0 && p.pDraw >= 0,
      `${h} v ${a} → ${JSON.stringify(p)}`);
  }
});

test('home advantage is inherited from lib/elo.js, not chosen here', () => {
  // team_elo is BUILT with these constants. A calibration has to describe the
  // ladder that actually runs.
  assert.strictEqual(DEFAULTS.homeAdv, ELO_HOME_ADV);
});

test('level ratings still favour the home side', () => {
  const p = eloProbs(1500, 1500);
  assert.ok(p.pHome > p.pAway, 'home advantage vanished');
});

test('the draw peaks at parity and decays with the gap', () => {
  const at = d => drawProb(d, 0.5, DEFAULTS);
  assert.ok(at(0) > at(200), 'draw did not decay by 200 points');
  assert.ok(at(200) > at(600), 'draw did not decay by 600 points');
  assert.ok(Math.abs(at(0) - DEFAULTS.drawAtParity) < 1e-12, 'parity draw is not the fitted value');
});

test('a missing rating yields null, never a defaulted one', () => {
  // A rating defaulted to 1500 is the ABSENCE of a read wearing a number, and
  // downstream it would be scored as though it were one.
  assert.strictEqual(eloProbs(null, 1500), null);
  assert.strictEqual(eloProbs(1500, undefined), null);
  assert.strictEqual(eloProbs('', 1500), null);
  assert.strictEqual(eloProbs(NaN, 1500), null);
});

test('a zero rating is a real rating, not a missing one', () => {
  // The Number(null) family: `Number('')` and `Number(null)` are both 0, so a
  // coercion bug here would turn a missing rating into a 1500-point gap.
  assert.ok(eloProbs(0, 0) !== null);
});

test('a non-positive draw spread is refused rather than dividing by zero', () => {
  assert.strictEqual(eloProbs(1500, 1500, { drawSpread: 0 }), null);
});

test('fitted params override the compiled fallbacks', () => {
  const a = eloProbs(1500, 1500, { drawAtParity: 0.10 });
  const b = eloProbs(1500, 1500, { drawAtParity: 0.30 });
  assert.ok(b.pDraw > a.pDraw, 'drawAtParity had no effect');
  assert.ok(Math.abs(a.pHome + a.pDraw + a.pAway - 1) < 1e-12);
});

console.log(`\nelo probs: ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
