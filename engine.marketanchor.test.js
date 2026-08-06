'use strict';

/**
 * engine.marketanchor.test.js — the market-anchored signal path and the model
 * veto. Zero deps, no DB / network.
 *
 * The tests that matter most here are not the arithmetic ones. They are the
 * ones that assert the ARCHITECTURE: that no model probability can raise a
 * score, open a gate or move an edge, and that the veto can only ever subtract.
 * Those are the rules the 6 Aug 2026 ruling exists to enforce, and a rule with
 * no test is a rule until someone is in a hurry.
 */

const assert = require('assert');
const ma = require('./lib/marketAnchor');
const veto = require('./lib/modelVeto');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}
const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

// ── The architecture ────────────────────────────────────────────────────────
console.log('\nmarket anchor — the model cannot price, flag or score');

test('evaluate() exposes no parameter that carries a model probability', () => {
  // The ONLY model-derived input is `vetoed`, a boolean. If someone adds a
  // modelProb parameter to this module, this test is the tripwire.
  const src = require('fs').readFileSync(require.resolve('./lib/marketAnchor'), 'utf8');
  for (const banned of ['modelProb', 'model_prob', 'p_home', 'dixonColes', 'require(\'./dixonColes\')']) {
    assert.ok(!src.includes(banned),
      `lib/marketAnchor.js must not reference ${banned} — the model may not reach a price`);
  }
});

test('the veto can only subtract: no value of `vetoed` opens a closed gate', () => {
  const base = { edge: 0.05, fairProb: 0.45, bestPrice: 2.5, booksQuoting: 8 };
  assert.strictEqual(ma.gate({ ...base, vetoed: false }).pass, true);
  assert.strictEqual(ma.gate({ ...base, vetoed: true }).pass, false);
  // A failing selection cannot be rescued by NOT being vetoed.
  const bad = { edge: 0.001, fairProb: 0.45, bestPrice: 2.5, booksQuoting: 8 };
  assert.strictEqual(ma.gate({ ...bad, vetoed: false }).pass, false);
});

test('a vetoed signal keeps the SAME score it would have had — the model moves no number', () => {
  const args = { fairProb: 0.45, bestPrice: 2.5, booksQuoting: 8, confidenceOverride: 1 };
  const open = ma.evaluate({ ...args, vetoed: false });
  const shut = ma.evaluate({ ...args, vetoed: true });
  close(open.edge, shut.edge);
  assert.strictEqual(open.shadowScore, shut.shadowScore,
    'the veto must not change the score, only whether it is published');
  assert.strictEqual(shut.score, null, 'a vetoed signal publishes no score');
  assert.strictEqual(shut.band, null);
});

test('score() takes only market inputs', () => {
  // Same edge and fair probability ⇒ same score, whatever else is happening.
  const a = ma.score({ edge: 0.04, fairProb: 0.50, confidence: 1 });
  const b = ma.score({ edge: 0.04, fairProb: 0.50, confidence: 1 });
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.band, b.band);
});

// ── The gate ────────────────────────────────────────────────────────────────
console.log('\nmarket anchor — the gate');

test('each threshold rejects on its own, and every failure is reported', () => {
  const ok = { edge: 0.05, fairProb: 0.45, bestPrice: 2.5, booksQuoting: 8 };
  assert.deepStrictEqual(ma.gate(ok).failures, []);
  assert.deepStrictEqual(ma.gate({ ...ok, edge: 0.019 }).failures, ['edge']);
  assert.deepStrictEqual(ma.gate({ ...ok, fairProb: 0.299 }).failures, ['fair_prob']);
  assert.deepStrictEqual(ma.gate({ ...ok, bestPrice: 4.51 }).failures, ['best_price']);
  assert.deepStrictEqual(ma.gate({ ...ok, booksQuoting: 5 }).failures, ['books']);
  // All of them at once — "why is the board empty" deserves a whole answer.
  assert.deepStrictEqual(
    ma.gate({ edge: 0, fairProb: 0.1, bestPrice: 9, booksQuoting: 1, vetoed: true }).failures,
    ['edge', 'fair_prob', 'best_price', 'books', 'model_veto']);
});

test('the boundaries are inclusive where the spec says >= and <=', () => {
  const at = { edge: 0.02, fairProb: 0.30, bestPrice: 4.50, booksQuoting: 6 };
  assert.strictEqual(ma.gate(at).pass, true, 'exactly-at-threshold must pass');
});

test('missing or non-numeric inputs fail the gate rather than coercing to 0', () => {
  // Number(null) is 0, which passes a `<= 4.50` price check. It must not.
  for (const bad of [null, undefined, '', NaN, 'abc']) {
    assert.strictEqual(ma.gate({ edge: 0.05, fairProb: 0.45, bestPrice: bad, booksQuoting: 8 }).pass,
      false, `bestPrice ${JSON.stringify(bad)} must fail`);
    assert.strictEqual(ma.gate({ edge: bad, fairProb: 0.45, bestPrice: 2.5, booksQuoting: 8 }).pass,
      false, `edge ${JSON.stringify(bad)} must fail`);
  }
});

test('a failed gate carries score null, never 0', () => {
  const r = ma.evaluate({ fairProb: 0.45, bestPrice: 1.05, booksQuoting: 8 });
  assert.strictEqual(r.passes, false);
  assert.strictEqual(r.score, null, 'a 0 would sort and filter like a weak signal');
  assert.strictEqual(r.band, null);
});

// ── MES ─────────────────────────────────────────────────────────────────────
console.log('\nmarket anchor — MES and its bands');

test('the three components carry their stated weights', () => {
  // A: edge at/above the 8% ceiling ⇒ full 50.
  close(ma.score({ edge: 0.08, fairProb: 0.30, confidence: 0 }).components.A, 50);
  close(ma.score({ edge: 0.16, fairProb: 0.30, confidence: 0 }).components.A, 50, 1e-9);
  close(ma.score({ edge: 0.04, fairProb: 0.30, confidence: 0 }).components.A, 25);
  // B: fair prob at/above 0.75 ⇒ full 35; at the 0.30 floor ⇒ 0.
  close(ma.score({ edge: 0, fairProb: 0.75, confidence: 0 }).components.B, 35);
  close(ma.score({ edge: 0, fairProb: 0.30, confidence: 0 }).components.B, 0);
  close(ma.score({ edge: 0, fairProb: 0.525, confidence: 0 }).components.B, 17.5);
  // C: full confidence ⇒ 15.
  close(ma.score({ edge: 0, fairProb: 0.30, confidence: 1 }).components.C, 15);
});

test('MES is capped at 100 and floored at 0', () => {
  const max = ma.score({ edge: 5, fairProb: 0.99, confidence: 1 });
  assert.strictEqual(max.score, 100);
  const min = ma.score({ edge: -1, fairProb: 0, confidence: 0 });
  assert.strictEqual(min.score, 0);
});

test('band is a pure function of score and nothing else', () => {
  assert.strictEqual(ma.bandFor(65), 'PRIME');
  assert.strictEqual(ma.bandFor(100), 'PRIME');
  assert.strictEqual(ma.bandFor(64), 'STRONG');
  assert.strictEqual(ma.bandFor(50), 'STRONG');
  assert.strictEqual(ma.bandFor(49), 'TRACKED');
  assert.strictEqual(ma.bandFor(0), 'TRACKED');
  assert.strictEqual(ma.bandFor(null), null);
  assert.strictEqual(ma.bandFor(NaN), null);
});

test('score and band agree by construction — they are returned together', () => {
  // Sweep the whole space and assert the pair is always self-consistent. The
  // point of computing them in one place is that this can never fail.
  for (let e = -0.05; e <= 0.20; e += 0.005) {
    for (let p = 0.05; p <= 0.95; p += 0.05) {
      for (const c of [0, 0.5, 1]) {
        const r = ma.score({ edge: e, fairProb: p, confidence: c });
        assert.strictEqual(r.band, ma.bandFor(r.score),
          `score ${r.score} carried band ${r.band}`);
      }
    }
  }
});

test('only PRIME and STRONG are published bands', () => {
  assert.strictEqual(ma.isPublishedBand('PRIME'), true);
  assert.strictEqual(ma.isPublishedBand('STRONG'), true);
  assert.strictEqual(ma.isPublishedBand('TRACKED'), false);
  assert.strictEqual(ma.isPublishedBand(null), false);
});

test('the backtest constant is what the backtests actually used', () => {
  // Every historical figure quoted for this system was produced with C pinned.
  // If this changes, those figures stop describing the shipped scorer.
  assert.strictEqual(ma.HELD_CONSTANT_CONFIDENCE, 1);
  assert.strictEqual(ma.CONFIDENCE_IS_UNVALIDATED, true);
  const r = ma.score({ edge: 0.02, fairProb: 0.30 });
  assert.strictEqual(r.components.C, 15, 'C defaults to the held-constant value');
});

// ── Component C ─────────────────────────────────────────────────────────────
console.log('\nmarket anchor — component C (unvalidated)');

test('confidence rises with books, with proximity to kickoff, and with stability', () => {
  const base = { booksQuoting: 6, hoursToKickoff: 72, fairProbDriftSinceOpen: 0.05 };
  close(ma.confidence(base), 0, 1e-12);
  const full = { booksQuoting: 12, hoursToKickoff: 6, fairProbDriftSinceOpen: 0 };
  close(ma.confidence(full), 1, 1e-12);
  assert.ok(ma.confidence({ ...base, booksQuoting: 12 }) > ma.confidence(base));
  assert.ok(ma.confidence({ ...base, hoursToKickoff: 2 }) > ma.confidence(base));
  assert.ok(ma.confidence({ ...base, fairProbDriftSinceOpen: 0 }) > ma.confidence(base));
});

test('a missing input lowers confidence rather than inventing it', () => {
  assert.strictEqual(ma.confidence({}), 0);
  assert.strictEqual(ma.confidence(), 0);
  // Drift is signed but only its magnitude matters — a market that has moved
  // toward us is still a market that has moved.
  close(ma.confidence({ booksQuoting: 12, hoursToKickoff: 6, fairProbDriftSinceOpen: -0.05 }),
        ma.confidence({ booksQuoting: 12, hoursToKickoff: 6, fairProbDriftSinceOpen: 0.05 }), 1e-12);
});

test('C can move a signal across a band boundary — which is why it needs validating', () => {
  const args = { edge: 0.045, fairProb: 0.52 };
  const lo = ma.score({ ...args, confidence: 0 });
  const hi = ma.score({ ...args, confidence: 1 });
  assert.ok(hi.score > lo.score);
  assert.notStrictEqual(hi.band, lo.band,
    'this configuration should straddle a boundary — if it stops doing so, pick another');
});

// ── Best price ──────────────────────────────────────────────────────────────
console.log('\nmarket anchor — best bettable price');

test('the anchor and the synthetic row are excluded from best price and count', () => {
  const quotes = [
    { bookmaker: 'pinnacle', odds: 5.0 },   // anchor — never the price
    { bookmaker: 'best', odds: 9.9 },       // synthetic — already a max
    { bookmaker: 'bet365', odds: 2.5 },
    { bookmaker: 'williamhill', odds: 2.6 },
  ];
  const r = ma.bestBettablePrice(quotes);
  assert.strictEqual(r.price, 2.6);
  assert.strictEqual(r.book, 'williamhill');
  assert.strictEqual(r.booksQuoting, 2, 'pinnacle and best must not be counted');
});

test('exchanges and unholdable books are excluded', () => {
  const quotes = [
    { bookmaker: 'betfair_ex_uk', odds: 8.0 },
    { bookmaker: 'smarkets', odds: 7.9 },
    { bookmaker: '1xbet', odds: 7.5 },
    { bookmaker: 'superbet', odds: 7.4 },
    { bookmaker: 'bet365', odds: 2.5 },
  ];
  const r = ma.bestBettablePrice(quotes);
  assert.strictEqual(r.price, 2.5);
  assert.strictEqual(r.booksQuoting, 1);
});

test('a book quoted twice counts once, at its better price', () => {
  const r = ma.bestBettablePrice([
    { bookmaker: 'bet365', odds: 2.4 },
    { bookmaker: 'bet365', odds: 2.7 },
    { bookmaker: 'skybet', odds: 2.5 },
  ]);
  assert.strictEqual(r.price, 2.7);
  assert.strictEqual(r.booksQuoting, 2);
});

test('junk prices and unknown books are dropped, not coerced', () => {
  const r = ma.bestBettablePrice([
    { bookmaker: 'bet365', odds: null },
    { bookmaker: 'skybet', odds: 0 },
    { bookmaker: 'betvictor', odds: '' },
    { bookmaker: 'some_new_book', odds: 99 },
    { bookmaker: 'unibet_uk', odds: '2.30' },
  ]);
  assert.strictEqual(r.price, 2.30, 'numeric strings are valid — Postgres sends them');
  assert.strictEqual(r.booksQuoting, 1);
});

test('an empty panel yields no price and no count', () => {
  for (const q of [[], null, undefined, [{ bookmaker: 'pinnacle', odds: 2 }]]) {
    const r = ma.bestBettablePrice(q);
    assert.strictEqual(r.price, null);
    assert.strictEqual(r.booksQuoting, 0);
  }
});

// ── Fair value from the anchor ──────────────────────────────────────────────
console.log('\nmarket anchor — fair value');

test('fair probabilities come from Pinnacle alone, Shin-de-vigged', () => {
  const r = ma.fairFromAnchor({ home: 2.10, draw: 3.40, away: 3.60 }, ['home', 'draw', 'away']);
  // Same golden as engine.devig.test.js.
  close(r.fair.home, 0.458665716, 1e-9);
  close(r.fair.draw, 0.2787376371, 1e-9);
  close(r.fair.away, 0.2625966469, 1e-9);
  close(r.fairPrices.home, 1 / 0.458665716, 1e-6);
  close(r.overround, 1.048085901, 1e-9);
});

test('an incomplete anchor produces no fair value at all', () => {
  const r = ma.fairFromAnchor({ home: 2.10, away: 3.60 }, ['home', 'draw', 'away']);
  assert.strictEqual(r.fair, null, 'two legs of a three-way book is not a market');
  assert.ok(r.reason);
});

// ── End to end ──────────────────────────────────────────────────────────────
console.log('\nmarket anchor — end to end');

test('edge is best price × fair probability − 1', () => {
  const r = ma.evaluate({ fairProb: 0.45, bestPrice: 2.40, booksQuoting: 8, confidenceOverride: 1 });
  close(r.edge, 0.45 * 2.40 - 1);
  close(r.edge, 0.08, 1e-12);
  assert.strictEqual(r.passes, true);
});

test('a real PRIME selection scores where expected', () => {
  // 8% edge (full A=50), fair prob 0.52 (B=17.11), full confidence (C=15).
  const r = ma.evaluate({ fairProb: 0.52, bestPrice: 2.0769230769, booksQuoting: 12,
                          hoursToKickoff: 6, fairProbDriftSinceOpen: 0 });
  close(r.edge, 0.08, 1e-6);
  assert.strictEqual(r.score, 82);
  assert.strictEqual(r.band, 'PRIME');
});

test('the tracked-but-unpublished set keeps a shadow score for measurement', () => {
  const r = ma.evaluate({ fairProb: 0.45, bestPrice: 2.5, booksQuoting: 3, confidenceOverride: 1 });
  assert.strictEqual(r.passes, false, 'three books is under the floor');
  assert.strictEqual(r.score, null);
  assert.ok(r.shadowScore > 0, 'band separation on rejected rows still needs measuring');
});

// ── The veto ────────────────────────────────────────────────────────────────
console.log('\nmodel veto — suppression only');

test('it fires only above theta', () => {
  const f = 0.50;
  assert.strictEqual(veto.shouldSuppress({ modelProb: 0.60, fairProb: f }).suppress, false);
  assert.strictEqual(veto.shouldSuppress({ modelProb: 0.75, fairProb: f }).suppress, false); // exactly 0.25
  assert.strictEqual(veto.shouldSuppress({ modelProb: 0.77, fairProb: f }).suppress, true);  // 0.27
  assert.strictEqual(veto.shouldSuppress({ modelProb: 0.23, fairProb: f }).suppress, true);  // symmetric
});

test('theta is the measured value and the grid is preserved', () => {
  assert.strictEqual(veto.DEFAULT_THETA, 0.26);
  assert.ok(veto.THETA_GRID.includes(0.26));
  assert.ok(veto.THETA_GRID.length >= 18, 'the whole swept grid is kept for re-fits');
});

test('IT FAILS OPEN: a missing model probability never empties the board', () => {
  // Number(null) is 0, and a model probability of 0 is maximal divergence from
  // any fair price — the Number(null) bug here would suppress everything.
  for (const bad of [null, undefined, '', NaN, 'abc', -1, 2]) {
    const r = veto.shouldSuppress({ modelProb: bad, fairProb: 0.5 });
    assert.strictEqual(r.suppress, false,
      `modelProb ${JSON.stringify(bad)} must not suppress — silence is not an objection`);
  }
});

test('a suppression carries a human reason', () => {
  const r = veto.shouldSuppress({ modelProb: 0.90, fairProb: 0.40 });
  assert.strictEqual(r.suppress, true);
  close(r.gap, 0.50, 1e-12);
  assert.ok(/50\.0pp/.test(r.reason), `reason should state the gap: ${r.reason}`);
});

test('disagreementGap returns null rather than a misleading zero', () => {
  assert.strictEqual(veto.disagreementGap(null, 0.5), null);
  assert.strictEqual(veto.disagreementGap(0.5, null), null);
  close(veto.disagreementGap(0.62, 0.50), 0.12, 1e-12);
});

test('the scorecard is hidden below 6pp, where the two are statistically tied', () => {
  assert.strictEqual(veto.SCORECARD_MIN_GAP, 0.06);
  assert.strictEqual(veto.scorecardVisible(0.0599), false);
  assert.strictEqual(veto.scorecardVisible(0.06), true);
  assert.strictEqual(veto.scorecardVisible(0.20), true);
  assert.strictEqual(veto.scorecardVisible(null), false);
  assert.strictEqual(veto.scorecardVisible(undefined), false);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} market anchor + veto: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
