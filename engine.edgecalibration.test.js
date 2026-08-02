'use strict';

// Tests for lib/edgeCalibration — the statistics behind the daily edge review.
//
// The whole point of the module is to stop a noisy maximum being mistaken for a
// finding, so most of these tests are about what it REFUSES to conclude.

const assert = require('assert');
const {
  profitOf,
  isSettled,
  inBox,
  applyBox,
  wilson,
  bootstrapYield,
  sampleNeeded,
  normalQuantile,
  sidakAlpha,
  yieldLowerBound,
  summarise,
  edgeBandTable,
  oddsBandTable,
  sweepBoxes,
  recommend,
  sameBox,
  CURRENT_BOX,
} = require('./lib/edgeCalibration');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

/** Builds a settled signal row. */
let seq = 0;
const sig = (odds, edge, result, extra = {}) => ({
  id: `s${seq++}`,
  match_id: extra.match_id ?? `m${seq}`,
  market: extra.market ?? 'h2h',
  market_line: extra.market_line ?? null,
  outcome: extra.outcome ?? 'home',
  detected_odds: odds,
  detected_edge: edge,
  detected_at: extra.detected_at ?? '2026-07-10T00:00:00Z',
  clv: extra.clv ?? null,
  result,
});

// ---- profit / settlement -------------------------------------------------
console.log('\nprofitOf / isSettled');
test('a win returns odds − 1', () => assert.strictEqual(profitOf(sig(2.5, 0.05, 'win')), 1.5));
test('a loss returns −1', () => assert.strictEqual(profitOf(sig(2.5, 0.05, 'loss')), -1));
test('string odds coerce (Supabase numerics arrive as strings)', () =>
  assert.strictEqual(profitOf({ detected_odds: '3.000', result: 'win' }), 2));
test('pending is not settled', () =>
  assert.strictEqual(isSettled({ ...sig(2, 0.05, 'pending') }), false));
test('a settled row with no price is unusable', () =>
  assert.strictEqual(isSettled({ detected_odds: null, detected_edge: 0.05, result: 'win' }), false));

// ---- box membership ------------------------------------------------------
console.log('\ninBox');
const primeBox = { oddsMin: 1.4, oddsMax: 3.0, edgeMin: 0.04, edgeMax: 0.10 };
test('inside the box', () => assert.ok(inBox(sig(2.0, 0.06, 'win'), primeBox)));
test('odds lower bound is inclusive', () => assert.ok(inBox(sig(1.4, 0.06, 'win'), primeBox)));
test('odds upper bound is exclusive', () => assert.ok(!inBox(sig(3.0, 0.06, 'win'), primeBox)));
test('edge lower bound is inclusive', () => assert.ok(inBox(sig(2.0, 0.04, 'win'), primeBox)));
test('edge upper bound is exclusive', () => assert.ok(!inBox(sig(2.0, 0.10, 'win'), primeBox)));
test('null edgeMax is unbounded above', () =>
  assert.ok(inBox(sig(2.0, 0.90, 'win'), { ...primeBox, edgeMax: null })));

// ---- filter-then-dedupe ordering ----------------------------------------
console.log('\napplyBox — filters BEFORE collapsing conflicts');
test('keeps the in-box outcome when the higher-edge outcome is out of box', () => {
  // Same match+market: over at 15% edge (outside the box) and under at 6%
  // (inside). Deduping first would keep the 15% row and then filter it away,
  // scoring the box as having made no bet on a match it would have bet.
  const rows = [
    sig(2.2, 0.15, 'loss', { match_id: 'M', market: 'totals', market_line: 2.5, outcome: 'over' }),
    sig(2.0, 0.06, 'win', { match_id: 'M', market: 'totals', market_line: 2.5, outcome: 'under' }),
  ];
  const kept = applyBox(rows, primeBox);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].outcome, 'under');
});
test('collapses two in-box outcomes on one market to the higher edge', () => {
  const rows = [
    sig(2.0, 0.05, 'loss', { match_id: 'M', outcome: 'home' }),
    sig(2.4, 0.08, 'win', { match_id: 'M', outcome: 'away' }),
  ];
  const kept = applyBox(rows, primeBox);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].outcome, 'away');
});
test('different markets on one match are not conflicts', () => {
  const rows = [
    sig(2.0, 0.05, 'loss', { match_id: 'M', market: 'h2h' }),
    sig(2.1, 0.06, 'win', { match_id: 'M', market: 'btts', outcome: 'btts_yes' }),
  ];
  assert.strictEqual(applyBox(rows, primeBox).length, 2);
});

// ---- Wilson --------------------------------------------------------------
console.log('\nwilson');
test('0 of 21 does not claim a 0% ceiling', () => {
  const { lo, hi } = wilson(0, 21);
  assert.strictEqual(lo, 0);
  assert.ok(hi > 0.15 && hi < 0.20, `hi was ${hi}`);
});
test('half of 100 centres on 50%', () => {
  const { lo, hi } = wilson(50, 100);
  assert.ok(lo > 0.39 && lo < 0.41, `lo was ${lo}`);
  assert.ok(hi > 0.59 && hi < 0.61, `hi was ${hi}`);
});
test('the interval narrows as n grows', () => {
  const small = wilson(5, 10), big = wilson(500, 1000);
  assert.ok((big.hi - big.lo) < (small.hi - small.lo));
});
test('an empty sample yields no interval', () =>
  assert.deepStrictEqual(wilson(0, 0), { lo: null, hi: null }));

// ---- bootstrap -----------------------------------------------------------
console.log('\nbootstrapYield');
const evenProfits = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.2 : -1));
test('is deterministic — the same book gives the same interval twice', () => {
  const a = bootstrapYield(evenProfits);
  const b = bootstrapYield(evenProfits);
  assert.deepStrictEqual(a, b);
});
test('the interval brackets the sample mean', () => {
  const m = evenProfits.reduce((s, x) => s + x, 0) / evenProfits.length;
  const { lo, hi } = bootstrapYield(evenProfits);
  assert.ok(lo < m && m < hi, `mean ${m} not inside ${lo}..${hi}`);
});
test('a thin sample gets a wider interval than a fat one', () => {
  const thinCi = bootstrapYield(evenProfits.slice(0, 10));
  const fatCi = bootstrapYield(evenProfits);
  assert.ok((thinCi.hi - thinCi.lo) > (fatCi.hi - fatCi.lo));
});
test('fewer than two bets gets no interval', () =>
  assert.deepStrictEqual(bootstrapYield([1.5]), { lo: null, hi: null, iterations: 0 }));

// ---- sample sizing -------------------------------------------------------
console.log('\nsampleNeeded');
test('long prices need a bigger sample than short ones', () => {
  const shortPrice = Array.from({ length: 50 }, (_, i) => (i % 2 ? 0.9 : -1));
  const longPrice = Array.from({ length: 50 }, (_, i) => (i % 10 ? -1 : 9));
  assert.ok(sampleNeeded(longPrice) > sampleNeeded(shortPrice));
});
test('no variance, no answer', () => assert.strictEqual(sampleNeeded([1, 1, 1]), 0));

// ---- multiplicity machinery ---------------------------------------------
console.log('\nnormalQuantile / sidakAlpha / yieldLowerBound');
test('normalQuantile recovers the textbook quantiles', () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(normalQuantile(0.95) - 1.644854) < 1e-4);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
});
test('normalQuantile stays sane far out in the tail', () => {
  const z = normalQuantile(1 - 0.05 / 250);
  assert.ok(z > 3.2 && z < 3.8, `z was ${z}`);
});
test('sidakAlpha shrinks the per-test level as tests multiply', () => {
  assert.strictEqual(sidakAlpha(0.05, 1), 0.05);
  assert.ok(sidakAlpha(0.05, 250) < 0.0003);
});
test('the lower bound is not fooled by an all-wins band', () => {
  // Six bets, all won at 2.90. The raw sample variance is zero, so a bound
  // built on the observed spread alone would claim near-certainty from six
  // coin flips. The Wilson leg has to catch that.
  const bound = yieldLowerBound({ profits: Array(6).fill(1.9), wins: 6, avgOdds: 2.9, z: 3.34 });
  assert.ok(bound < 1.0, `bound was ${bound} — the zero-variance case leaked through`);
});
test('the lower bound sits below the observed yield', () => {
  const profits = Array.from({ length: 100 }, (_, i) => (i % 10 < 6 ? 1.0 : -1));
  const observed = profits.reduce((s, x) => s + x, 0) / profits.length;
  const bound = yieldLowerBound({ profits, wins: 60, avgOdds: 2.0, z: 1.96 });
  assert.ok(bound < observed, `${bound} should be below ${observed}`);
});
test('the lower bound rises as the same edge is confirmed on more bets', () => {
  const build = n => Array.from({ length: n }, (_, i) => (i % 10 < 6 ? 1.0 : -1));
  const small = yieldLowerBound({ profits: build(30), wins: 18, avgOdds: 2.0, z: 1.96 });
  const large = yieldLowerBound({ profits: build(600), wins: 360, avgOdds: 2.0, z: 1.96 });
  assert.ok(large > small, `${large} should exceed ${small}`);
});

// ---- summarise -----------------------------------------------------------
console.log('\nsummarise');
test('counts, strike and yield', () => {
  const s = summarise([sig(3, 0.05, 'win'), sig(3, 0.05, 'loss'), sig(3, 0.05, 'loss')]);
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 2);
  assert.ok(Math.abs(s.strike - 1 / 3) < 1e-9);
  assert.strictEqual(s.profit, 0);      // +2, −1, −1
  assert.strictEqual(s.yield, 0);
});
test('drops unsettled rows rather than scoring them', () => {
  const s = summarise([sig(2, 0.05, 'win'), sig(2, 0.05, 'pending')]);
  assert.strictEqual(s.n, 1);
});
test('CLV t-stat is null without at least two observations', () =>
  assert.strictEqual(summarise([sig(2, 0.05, 'win', { clv: 0.03 })]).clvT, null));
test('CLV t-stat rises with a consistent positive close', () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    sig(2, 0.05, i % 2 ? 'win' : 'loss', { clv: 0.02 + (i % 4) * 0.001 }));
  assert.ok(summarise(rows).clvT > 5);
});
test('an empty slice summarises to nulls, not NaN', () => {
  const s = summarise([]);
  assert.strictEqual(s.n, 0);
  assert.strictEqual(s.strike, null);
  assert.strictEqual(s.yield, null);
});

// ---- tables --------------------------------------------------------------
console.log('\nedgeBandTable / oddsBandTable');
const book = [
  ...Array.from({ length: 20 }, (_, i) => sig(2.0, 0.05, i < 12 ? 'win' : 'loss', { match_id: `a${i}` })),
  ...Array.from({ length: 20 }, (_, i) => sig(2.0, 0.12, i < 4 ? 'win' : 'loss', { match_id: `b${i}` })),
];
test('bands partition the book with no double counting', () => {
  const bands = edgeBandTable(book, { oddsMin: 1.4, oddsMax: 3.0 });
  assert.strictEqual(bands.reduce((s, b) => s + b.n, 0), 40);
});
test('a band reports the slice it covers', () => {
  const bands = edgeBandTable(book, { oddsMin: 1.4, oddsMax: 3.0 });
  const band = bands.find(b => b.edgeMin === 0.04 && b.edgeMax === 0.06);
  assert.strictEqual(band.n, 20);
  assert.strictEqual(band.wins, 12);
});
test('the odds table excludes rows below the edge floor given', () => {
  const rows = [sig(2.0, 0.01, 'win'), sig(2.0, 0.05, 'win')];
  const bands = oddsBandTable(rows, { edgeMin: 0.02 });
  assert.strictEqual(bands.reduce((s, b) => s + b.n, 0), 1);
});

// ---- sweep ---------------------------------------------------------------
console.log('\nsweepBoxes');
test('drops boxes below the minimum sample', () => {
  const { candidates } = sweepBoxes(book, { minSample: 15 });
  assert.ok(candidates.every(c => c.n >= 15));
});
test('ranks by the adjusted lower bound, not by yield', () => {
  // A tiny, spectacular band (5 of 6 at 2.90 — a +142% yield) beside a large,
  // solidly positive one. Ranking on yield picks the fluke; ranking on the
  // adjusted lower bound must pick the band with the evidence behind it.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      sig(2.9, 0.085, i < 5 ? 'win' : 'loss', { match_id: `hot${i}` })),
    ...Array.from({ length: 120 }, (_, i) =>
      sig(2.0, 0.05, i % 10 < 6 ? 'win' : 'loss', { match_id: `bulk${i}` })),
  ];
  const { candidates } = sweepBoxes(rows, { minSample: 5 });
  const byYield = [...candidates].sort((a, b) => b.yield - a.yield)[0];
  assert.ok(byYield.n < 20, 'the fluke band should be the yield leader — test setup is wrong');
  assert.ok(candidates[0].n >= 100,
    `top band had only ${candidates[0].n} bets — the fluke was ranked first`);
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].yieldLoAdj >= candidates[i].yieldLoAdj,
      'candidates are not sorted by adjusted lower bound');
  }
});
test('the correction tightens as more boxes clear the sample floor', () => {
  const rows = Array.from({ length: 400 }, (_, i) =>
    sig(1.5 + (i % 15) * 0.1, 0.02 + (i % 9) * 0.01, i % 3 ? 'loss' : 'win', { match_id: `w${i}` }));
  const few = sweepBoxes(rows, { minSample: 200 });
  const many = sweepBoxes(rows, { minSample: 5 });
  assert.ok(many.eligible > few.eligible, 'test setup did not vary the eligible count');
  assert.ok(many.z > few.z, `z should rise with ${many.eligible} boxes vs ${few.eligible}`);
  assert.ok(many.perTestAlpha < many.familyAlpha);
});
test('reports how many boxes were tested (best-of-N must stay visible)', () => {
  const { tested } = sweepBoxes(book);
  assert.ok(tested > 100, `only ${tested} boxes tested`);
});

// ---- recommendation gate -------------------------------------------------
console.log('\nrecommend');
const winners = (n, odds, edge, strikeRate, tag) =>
  Array.from({ length: n }, (_, i) =>
    sig(odds, edge, i % 100 < strikeRate * 100 ? 'win' : 'loss', { match_id: `${tag}${i}` }));

test('a thin book cannot move the box', () => {
  const v = recommend({ rows: winners(10, 2.0, 0.05, 0.6, 'x'), outOfSampleRows: [], sweep: sweepBoxes([]), minSample: 100 });
  assert.strictEqual(v.status, 'insufficient');
});
test('holds when nothing beats the current box', () => {
  const rows = winners(150, 2.0, 0.05, 0.55, 'y');
  const v = recommend({ rows, outOfSampleRows: rows, sweep: sweepBoxes(rows), minSample: 100 });
  assert.ok(['hold', 'advisory', 'shift'].includes(v.status));
  assert.strictEqual(sameBox(v.current.box, CURRENT_BOX), true);
});
test('refuses a candidate that has no out-of-sample support', () => {
  // Everything sits in the fitting window; the post-epoch set is empty, so no
  // candidate can be confirmed however good it looks.
  const rows = [
    ...winners(60, 2.0, 0.05, 0.45, 'lo'),
    ...winners(60, 2.6, 0.075, 0.62, 'hi'),
  ];
  const v = recommend({ rows, outOfSampleRows: [], sweep: sweepBoxes(rows, { minSample: 20 }), minSample: 50 });
  assert.ok(v.status === 'hold' || v.status === 'insufficient');
  assert.match(v.reason, /out-of-sample|Hold/);
});
test('never returns shift below the confirmation sample', () => {
  const inS = winners(40, 2.5, 0.075, 0.7, 'a');
  const outS = winners(40, 2.5, 0.075, 0.7, 'b');
  const rows = [...inS, ...outS];
  const v = recommend({
    rows, outOfSampleRows: outS,
    sweep: sweepBoxes(rows, { minSample: 20 }),
    minSample: 50, confirmSample: 500,
  });
  assert.notStrictEqual(v.status, 'shift');
});
test('a verdict always carries the current box for comparison', () => {
  const rows = winners(120, 2.0, 0.05, 0.5, 'z');
  const v = recommend({ rows, outOfSampleRows: rows, sweep: sweepBoxes(rows), minSample: 50 });
  assert.ok(v.current && typeof v.current.n === 'number');
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
});

// ---- summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
