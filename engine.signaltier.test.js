/**
 * engine.signaltier.test.js — the two ladders, and the line between them.
 * Run: node engine.signaltier.test.js
 *
 * lib/signalTier.js carries an ELIGIBILITY ladder (price + edge → may we suggest
 * this) and a CONVICTION ladder (MaxEdgeScore → how strongly does it read). They
 * shared words until 6 Aug 2026 and the shared words meant different things, so
 * these cases pin what each one answers and that neither answers the other.
 */
'use strict';
const assert = require('assert');
const {
  classifyTier, categoryFor, isPrime,
  LABELS, BAND_MIN, bandFor, isBacked,
  THRESHOLDS,
} = require('./lib/signalTier');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

/* ── The conviction ladder ─────────────────────────────────────────────── */

test('names the five rungs, strongest first, and nothing else', () => {
  assert.deepStrictEqual([...LABELS], ['PRIME', 'WATCH', 'SLIGHT', 'TRACE', 'NIL']);
});

test('carries none of the eligibility ladder’s words', () => {
  // Value and Longshot are buckets of the OTHER ladder. A rung named Value was
  // how a count and a verdict came to look like the same claim on screen.
  // STRONG came off this list on 6 Aug 2026 and went back on it on 21 Aug, when
  // the 2σ rung was retired and PRIME came down to the 1σ line — leaving STRONG
  // nowhere to stand that was not below the backing line, which is the
  // declined to back the reading. The prohibition was never about the word.
  for (const dead of ['VALUE', 'LONGSHOT', 'STANDARD', 'MODERATE']) {
    assert.ok(!LABELS.includes(dead), `${dead} is not a rung`);
  }
});

test('bands at 10 / 23 / 41 / 65, every one a round sigma', () => {
  assert.strictEqual(bandFor(99), 'PRIME');
  assert.strictEqual(bandFor(88), 'PRIME');
  assert.strictEqual(bandFor(87), 'PRIME');
  assert.strictEqual(bandFor(65), 'PRIME');
  assert.strictEqual(bandFor(64), 'WATCH');
  assert.strictEqual(bandFor(41), 'WATCH');
  assert.strictEqual(bandFor(40), 'SLIGHT');
  assert.strictEqual(bandFor(23), 'SLIGHT');
  assert.strictEqual(bandFor(22), 'TRACE');
  assert.strictEqual(bandFor(10), 'TRACE');
  assert.strictEqual(bandFor(9), 'NIL');
  assert.strictEqual(bandFor(0), 'NIL');
  // 65 is still the selection boundary BY CONSTRUCTION, and since 21 Aug 2026
  // it belongs to PRIME again — the 2σ rung above it named a band no row has
  // ever occupied. isBacked() reads the cutoff, which is why the relabel moved
  // no row: same 65, different word.
  assert.strictEqual(BAND_MIN.PRIME, 65);
  assert.strictEqual(BAND_MIN.STRONG, undefined);
  for (let mxs = 0; mxs <= 100; mxs++) {
    assert.strictEqual(isBacked(mxs), mxs >= 65, `mxs ${mxs}`);
  }
});

test('backed means at or above the 1 sigma line, not the top rung', () => {
  // The bug this pins: `bandFor(mxs) === 'PRIME'` after the re-cut would have
  // moved every backed check from 65 to 88 without looking like a threshold
  // change — including the Telegram broadcast gate.
  assert.strictEqual(isBacked(88), true);
  assert.strictEqual(isBacked(65), true);
  assert.strictEqual(isBacked(64), false);
  assert.strictEqual(isBacked(null), false);
});

test('an unscorable row is null, never the bottom rung', () => {
  // "We could not score this" and "we scored it and found nothing" are
  // different statements and the UI renders them differently.
  for (const v of [null, undefined, '', 'x', NaN]) {
    assert.strictEqual(bandFor(v), null, `${String(v)} scores nothing`);
  }
  assert.strictEqual(bandFor(0), 'NIL', 'a genuine zero survives as a value');
});

test('only PRIME is backed', () => {
  assert.strictEqual(isBacked(88), true);
  assert.strictEqual(isBacked(64), false);
  assert.strictEqual(isBacked(null), false);
});

/* ── The eligibility ladder, unchanged ─────────────────────────────────── */

test('the profitable box is the only suggested, tracked bucket', () => {
  const r = classifyTier({ odds: 2.00, edge: 0.06 });
  assert.strictEqual(r.tier, 'prime');
  assert.strictEqual(r.suggested, true);
  assert.strictEqual(r.tracked, true);
});

test('odds 3.00+ is a longshot — shown, never suggested, never tracked', () => {
  const r = classifyTier({ odds: 4.50, edge: 0.07 });
  assert.strictEqual(r.tier, 'longshot');
  assert.strictEqual(r.suggested, false);
  assert.strictEqual(r.tracked, false);
  assert.strictEqual(r.notable, true, '6–10% is the notable sub-band');
});

test('the visibility floor is evaluated before the longshot band', () => {
  // Ordering matters and migration 033's backfill mirrors it exactly: a
  // sub-floor long-odds row maps to value, not longshot.
  assert.strictEqual(classifyTier({ odds: 8.0, edge: 0.01 }).tier, null);
  assert.strictEqual(categoryFor({ odds: 8.0, edge: 0.01 }), 'value');
  assert.strictEqual(THRESHOLDS.VALUE_MIN_EDGE, 0.02);
});

test('categoryFor writes only the three canonical bucket names, LOWER CASE', () => {
  // The database is the authority and it admits exactly these three:
  //   value_signals_signal_category_check
  //     CHECK (signal_category IS NULL OR signal_category = ANY
  //            (ARRAY['prime', 'value', 'longshot']))
  // This test asserted the TITLE-CASED words for twelve days after
  // categoryFor stopped producing them, so it failed on every run and told
  // nobody anything. Had the code actually still emitted 'Prime', every 1X2
  // insert would have been rejected by that constraint — the test was red
  // about the one thing that could not have been true.
  const BUCKETS = ['prime', 'value', 'longshot'];
  const seen = new Set([
    categoryFor({ odds: 2.0, edge: 0.06 }),
    categoryFor({ odds: 2.0, edge: 0.30 }),
    categoryFor({ odds: 6.0, edge: 0.08 }),
    categoryFor({ odds: 6.0, edge: 0.001 }),
    categoryFor(null),
  ]);
  for (const v of seen) {
    assert.ok(BUCKETS.includes(v), v);
    // The property that actually broke, asserted as a property rather than as
    // a list of literals: a re-title-cased bucket key fails here even if
    // somebody remembers to update the list above.
    assert.strictEqual(v, v.toLowerCase(), `${v} is a badge word, not a bucket key`);
  }
});

/* ── The line between them ─────────────────────────────────────────────── */

test('the two ladders can disagree, and that is a fact not a bug', () => {
  // A 4.50 shot with a fat edge is quarantined by the eligibility ladder and
  // may still score high. The engine records both; the product prints the
  // conviction rung and lets the eligibility ladder decide what is offered.
  const row = { odds: 4.50, edge: 0.09 };
  assert.strictEqual(isPrime(row), false, 'not suggested');
  assert.strictEqual(isBacked(80), true, 'reads strongly all the same');
});

test('neither ladder is reachable from the other', () => {
  // bandFor takes a score and nothing else; classifyTier takes a price and an
  // edge and nothing else. Neither can be derived from the other's inputs.
  assert.strictEqual(bandFor(classifyTier({ odds: 2.0, edge: 0.06 }).tier), null);
});


/* ── The 3% floor, and that it is ONE constant ─────────────────────────── */

test('suggests at exactly 3.0% and declines a hair under it', () => {
  // Lowered 4% -> 3% by owner ruling, 22 Aug 2026. The band this admits —
  // 3-4% at odds 1.40-3.00 — returns +6.26% over 38 settled bets, z 0.35:
  // positive and indistinguishable from zero, which was the cost stated when
  // the ruling was made. The band above it is +15.71% over 143, z 1.64.
  assert.strictEqual(THRESHOLDS.PRIME_EDGE_MIN, 0.03);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0300 }).suggested, true);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0299 }).suggested, false);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0350 }).suggested, true);
  // The cap did not move with the floor.
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0999 }).suggested, true);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.1001 }).suggested, false);
  // And the PRICE leg is unchanged in both directions.
  assert.strictEqual(classifyTier({ odds: 1.39, edge: 0.05 }).suggested, false);
  assert.strictEqual(classifyTier({ odds: 3.00, edge: 0.05 }).suggested, false);
});

test('the floor the ENGINE applies is the one f(edge) reads', () => {
  // `lib/maxedge.js` reads THRESHOLDS.PRIME_EDGE_MIN for its plateau — that
  // direction, because maxedge already requires signalTier and the reverse is
  // a cycle. Typed separately they drifted within twenty-four hours, so this
  // asserts the wiring rather than the number.
  const { EDGE_EFFICIENCY, edgeEfficiency } = require('./lib/maxedge');
  assert.strictEqual(EDGE_EFFICIENCY.plateauFrom, THRESHOLDS.PRIME_EDGE_MIN);
  // At the floor the score is undecayed and the box suggests: the two agree
  // at the same point, which is the whole reason they share a constant.
  assert.strictEqual(edgeEfficiency(THRESHOLDS.PRIME_EDGE_MIN), 1);
  assert.strictEqual(
    classifyTier({ odds: 2.00, edge: THRESHOLDS.PRIME_EDGE_MIN }).suggested, true);
});

console.log(`\n  ${passed} passed`);
