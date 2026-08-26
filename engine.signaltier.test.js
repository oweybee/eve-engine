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
  LABELS, BAND_MIN, bandFor, isBacked, rungFor, capAtWatch,
  THRESHOLDS,
} = require('./lib/signalTier');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

/* ── The conviction ladder ─────────────────────────────────────────────── */

test('names the six rungs, strongest first, and nothing else', () => {
  // EDGE joined on 26 Aug 2026. It is the only rung here that is NOT a score
  // band — it is a BOX rung, which is why it has no BAND_MIN entry.
  assert.deepStrictEqual([...LABELS], ['PRIME', 'EDGE', 'WATCH', 'SLIGHT', 'TRACE', 'NIL']);
  assert.strictEqual(BAND_MIN.EDGE, undefined, 'EDGE is a box rung, not a score band');
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

test('bands at 10 / 23 / 41 / 60 — and 60 is CHOSEN, not derived', () => {
  assert.strictEqual(bandFor(99), 'PRIME');
  assert.strictEqual(bandFor(60), 'PRIME');
  // MOVED 65 -> 60 on 26 Aug 2026. This assertion pinned 65 and had to fail:
  // the score no longer SELECTS, it only demotes, so the line stopped needing
  // to sit on a whole error bar. 12 of 25 in-box rows clear 60; at 65 it was a
  // handful.
  assert.strictEqual(bandFor(59), 'WATCH');
  assert.strictEqual(bandFor(41), 'WATCH');
  assert.strictEqual(bandFor(40), 'SLIGHT');
  assert.strictEqual(bandFor(23), 'SLIGHT');
  assert.strictEqual(bandFor(22), 'TRACE');
  assert.strictEqual(bandFor(10), 'TRACE');
  assert.strictEqual(bandFor(9), 'NIL');
  assert.strictEqual(bandFor(0), 'NIL');
  assert.strictEqual(BAND_MIN.PRIME, 60);
  assert.strictEqual(BAND_MIN.STRONG, undefined);
});

test('the box picks the rung and the score can only demote', () => {
  // A perfect score outside the box buys nothing.
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.049, mxs: 99 }), 'WATCH');
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.15,  mxs: 99 }), 'WATCH');
  assert.strictEqual(rungFor({ odds: 3.50, edge: 0.06,  mxs: 99 }), 'WATCH');
  // A 7-9.9% row is never PRIME, however it scores.
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.08, mxs: 99 }), 'EDGE');
  // Demotion inside the PRIME box.
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.06, mxs: 60 }), 'PRIME');
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.06, mxs: 59 }), 'EDGE');
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.06, mxs: 40 }), 'SLIGHT');
  // No score is not a low score.
  assert.strictEqual(rungFor({ odds: 2.00, edge: 0.06, mxs: null }), null);
  // The cap that text-sorting gets wrong: 'PRIME' < 'WATCH' alphabetically.
  assert.strictEqual(capAtWatch('PRIME'), 'WATCH');
  assert.strictEqual(capAtWatch('SLIGHT'), 'SLIGHT');
});

test('rungFor is monotonic in score and never promotes across the box', () => {
  // Walk every score at four price/edge points. The rung may only weaken as the
  // score falls, and a row outside the box may never reach a backed rung.
  const order = ['NIL', 'TRACE', 'SLIGHT', 'WATCH', 'EDGE', 'PRIME'];
  for (const [odds, edge] of [[2.00, 0.06], [2.00, 0.08], [2.00, 0.04], [3.50, 0.06]]) {
    let prev = -1;
    for (let mxs = 0; mxs <= 100; mxs++) {
      const rung = rungFor({ odds, edge, mxs });
      const rank = order.indexOf(rung);
      assert.ok(rank >= prev, `rung weakened as score rose at ${odds}/${edge}/${mxs}`);
      prev = rank;
      const inPrimeBox = edge >= 0.05 && edge < 0.07 && odds >= 1.40 && odds < 3.00;
      const inEdgeBox  = edge >= 0.07 && edge < 0.10 && odds >= 1.40 && odds < 3.00;
      if (!inPrimeBox && !inEdgeBox) {
        assert.ok(rung !== 'PRIME' && rung !== 'EDGE',
          `out-of-box row reached ${rung} at score ${mxs}`);
      }
      if (!inPrimeBox) assert.notStrictEqual(rung, 'PRIME', `only the PRIME box may be PRIME`);
    }
  }
});

test('isBacked takes a ROW now, and a bare score is silently false', () => {
  // THE SIGNATURE CHANGED on 26 Aug 2026 and this is the failure mode: a bare
  // number destructures to undefined odds/edge, rungFor returns null, and this
  // returns false WITHOUT THROWING. A missed call site does not announce
  // itself — the broadcast channel just goes quiet.
  assert.strictEqual(isBacked(99), false, 'a bare score must not read as backed');
  assert.strictEqual(isBacked(60), false);

  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.06, mxs: 60 }), true,  'PRIME');
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.06, mxs: 41 }), true,  'demoted to EDGE');
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.08, mxs: 41 }), true,  'EDGE band');
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.06, mxs: 40 }), false, 'below WATCH');
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.04, mxs: 99 }), false, 'outside the box');
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.06, mxs: null }), false, 'unscored');
});

test('an unscorable row is null, never the bottom rung', () => {
  // "We could not score this" and "we scored it and found nothing" are
  // different statements and the UI renders them differently.
  for (const v of [null, undefined, '', 'x', NaN]) {
    assert.strictEqual(bandFor(v), null, `${String(v)} scores nothing`);
  }
  assert.strictEqual(bandFor(0), 'NIL', 'a genuine zero survives as a value');
});

test('two rungs are backed now, and only those two', () => {
  const backed = ['PRIME', 'EDGE'];
  for (const rung of LABELS) {
    const shouldBack = backed.includes(rung);
    assert.strictEqual(
      rung === 'PRIME' ? isBacked({ odds: 2.00, edge: 0.06, mxs: 60 })
      : rung === 'EDGE' ? isBacked({ odds: 2.00, edge: 0.08, mxs: 60 })
      : false,
      shouldBack, `${rung}`);
  }
  assert.strictEqual(isBacked({ odds: 2.00, edge: 0.06, mxs: null }), false);
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
  assert.strictEqual(bandFor(80), 'PRIME', 'the SCORE still reads strongly');
  // But the printed rung is capped, because the box declines the price.
  assert.strictEqual(rungFor({ ...row, mxs: 80 }), 'WATCH');
  assert.strictEqual(isBacked({ ...row, mxs: 80 }), false);
});

test('neither ladder is reachable from the other', () => {
  // bandFor takes a score and nothing else; classifyTier takes a price and an
  // edge and nothing else. Neither can be derived from the other's inputs.
  assert.strictEqual(bandFor(classifyTier({ odds: 2.0, edge: 0.06 }).tier), null);
});


/* ── The two backed bands, and that they are ONE set of constants ──────── */

test('two backed bands, and the seam between them is exact', () => {
  // MOVED 3% -> 5% on 26 Aug 2026. The band this closes is not merely unproven:
  // inside the price box everything below 5% returns -11.88% at clustered
  // z -1.51 over 163 fixtures, and 4.0-4.9% alone is -19.36% and has been
  // negative in every period since June.
  assert.strictEqual(THRESHOLDS.PRIME_EDGE_MIN, 0.05);
  assert.strictEqual(THRESHOLDS.PRIME_EDGE_MAX, 0.07);
  assert.strictEqual(THRESHOLDS.EDGE_EDGE_MIN,  0.07);
  assert.strictEqual(THRESHOLDS.EDGE_EDGE_MAX,  0.10);
  // No gap and no overlap: PRIME's cap IS EDGE's floor.
  assert.strictEqual(THRESHOLDS.PRIME_EDGE_MAX, THRESHOLDS.EDGE_EDGE_MIN);

  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0499 }).tier, 'value');
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0500 }).tier, 'prime');
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0699 }).tier, 'prime');
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0700 }).tier, 'edge');
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.0999 }).tier, 'edge');
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.1000 }).tier, 'value');

  // Both backed bands are SUGGESTED — both go to the channel.
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.06 }).suggested, true);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.08 }).suggested, true);
  // Only PRIME is TRACKED — only PRIME feeds the headline record.
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.06 }).tracked, true);
  assert.strictEqual(classifyTier({ odds: 2.00, edge: 0.08 }).tracked, false);

  // And the PRICE leg is unchanged in both directions.
  assert.strictEqual(classifyTier({ odds: 1.39, edge: 0.06 }).suggested, false);
  assert.strictEqual(classifyTier({ odds: 3.00, edge: 0.06 }).suggested, false);
});

test('NOTABLE is gone and `notable` reads the backed band', () => {
  // It was a separately-chosen 6-10% range. It now points at the SAME span the
  // product backs at short prices, so "best of the longshots" means the band
  // with the measured edge rather than a range nobody re-derived.
  assert.strictEqual(THRESHOLDS.NOTABLE_EDGE_MIN, undefined);
  assert.strictEqual(THRESHOLDS.NOTABLE_EDGE_MAX, undefined);
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.049 }).notable, false);
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.05  }).notable, true);
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.099 }).notable, true);
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.10  }).notable, false);
  // Still never suggested and never tracked, whatever `notable` says.
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.06 }).suggested, false);
  assert.strictEqual(classifyTier({ odds: 4.00, edge: 0.06 }).tracked, false);
});

test('EDGE is broadcast but never counted in the headline record', () => {
  // The asymmetry this file exists to pin. If EDGE ever stops being shown as
  // prominently as PRIME, flip `tracked` back to true rather than keeping the
  // flattering number — see performance_band.headline_scope_note.
  const edge = classifyTier({ odds: 2.00, edge: 0.08 });
  assert.strictEqual(edge.suggested, true,  'broadcast');
  assert.strictEqual(edge.tracked,   false, 'not in the headline record');
  assert.strictEqual(categoryFor({ odds: 2.00, edge: 0.08 }), 'edge');
});

test('every seam of f(edge) is DERIVED from the box, not retyped', () => {
  // `lib/maxedge.js` reads THRESHOLDS for all three seams — that direction,
  // because maxedge already requires signalTier and the reverse is a cycle.
  // Typed separately they drifted within twenty-four hours on 22 Aug, so this
  // asserts the wiring rather than the numbers.
  const { EDGE_EFFICIENCY, edgeEfficiency } = require('./lib/maxedge');
  assert.strictEqual(EDGE_EFFICIENCY.rampTo,     THRESHOLDS.PRIME_EDGE_MIN);
  assert.strictEqual(EDGE_EFFICIENCY.peakTo,     THRESHOLDS.PRIME_EDGE_MAX);
  assert.strictEqual(EDGE_EFFICIENCY.edgeBandTo, THRESHOLDS.EDGE_EDGE_MAX);
  assert.strictEqual(EDGE_EFFICIENCY.plateauFrom, undefined, 'renamed to rampTo');

  // The three cliffs sit exactly on the box boundaries. r4 because the ramp is
  // floating-point: f(0.04) lands on 0.6799999999999999.
  const r4 = x => Math.round(x * 1e4) / 1e4;
  assert.strictEqual(r4(edgeEfficiency(0.04)),   0.68, 'the runbook value');
  assert.strictEqual(r4(edgeEfficiency(0.0499)), 0.7493, 'ramp tops at 0.75');
  assert.strictEqual(edgeEfficiency(0.05),   1);
  assert.strictEqual(edgeEfficiency(0.0699), 1);
  assert.strictEqual(edgeEfficiency(0.07),   0.85);
  assert.strictEqual(edgeEfficiency(0.0999), 0.85);
  // A decay, never a boost.
  assert.ok(edgeEfficiency(0.049) < 1);
  assert.strictEqual(edgeEfficiency(0.15), EDGE_EFFICIENCY.trap);
  // At the floor the score is undecayed and the box suggests: the two agree at
  // the same point, which is the whole reason they share a constant.
  assert.strictEqual(edgeEfficiency(THRESHOLDS.PRIME_EDGE_MIN), 1);
  assert.strictEqual(
    classifyTier({ odds: 2.00, edge: THRESHOLDS.PRIME_EDGE_MIN }).suggested, true);
});

console.log(`\n  ${passed} passed`);
