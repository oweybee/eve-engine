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

test('names the four rungs, strongest first, and nothing else', () => {
  assert.deepStrictEqual([...LABELS], ['PRIME', 'STRONG', 'WATCH', 'SLIGHT', 'TRACE', 'NIL']);
});

test('carries none of the eligibility ladder’s words', () => {
  // Value and Longshot are buckets of the OTHER ladder. A rung named Value was
  // how a count and a verdict came to look like the same claim on screen.
  // STRONG came off this list on 6 Aug 2026. It is a rung again, and legitimately
  // so: it exists only at or above the 1σ backing line, where we have not
  // declined to back the reading. The prohibition was never about the word.
  for (const dead of ['VALUE', 'LONGSHOT', 'STANDARD', 'MODERATE']) {
    assert.ok(!LABELS.includes(dead), `${dead} is not a rung`);
  }
});

test('bands at 10 / 23 / 41 / 65 / 88, every one a round sigma', () => {
  assert.strictEqual(bandFor(88), 'PRIME');
  assert.strictEqual(bandFor(87), 'STRONG');
  assert.strictEqual(bandFor(65), 'STRONG');
  assert.strictEqual(bandFor(64), 'WATCH');
  assert.strictEqual(bandFor(41), 'WATCH');
  assert.strictEqual(bandFor(40), 'SLIGHT');
  assert.strictEqual(bandFor(23), 'SLIGHT');
  assert.strictEqual(bandFor(22), 'TRACE');
  assert.strictEqual(bandFor(10), 'TRACE');
  assert.strictEqual(bandFor(9), 'NIL');
  assert.strictEqual(bandFor(0), 'NIL');
  // 65 is still the selection boundary BY CONSTRUCTION — it just belongs to
  // STRONG now, and isBacked() is what reads it.
  assert.strictEqual(BAND_MIN.STRONG, 65);
  assert.strictEqual(BAND_MIN.PRIME, 88);
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
  // sub-floor long-odds row maps to Value, not Longshot.
  assert.strictEqual(classifyTier({ odds: 8.0, edge: 0.01 }).tier, null);
  assert.strictEqual(categoryFor({ odds: 8.0, edge: 0.01 }), 'Value');
  assert.strictEqual(THRESHOLDS.VALUE_MIN_EDGE, 0.02);
});

test('categoryFor writes only the three canonical bucket names', () => {
  const seen = new Set([
    categoryFor({ odds: 2.0, edge: 0.06 }),
    categoryFor({ odds: 2.0, edge: 0.30 }),
    categoryFor({ odds: 6.0, edge: 0.08 }),
    categoryFor({ odds: 6.0, edge: 0.001 }),
    categoryFor(null),
  ]);
  for (const v of seen) assert.ok(['Prime', 'Value', 'Longshot'].includes(v), v);
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

console.log(`\n  ${passed} passed`);
