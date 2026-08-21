/**
 * engine.disagreementfit.test.js — the scorecard's banding and replay rules.
 *
 * These decide what the product is allowed to claim about its own record, and
 * two of them are the exact shapes that produce a plausible wrong answer: a
 * band boundary that admits a gap into two buckets, and an Elo replay that has
 * already seen the result it is about to predict.
 *
 * Run: node --test engine.disagreementfit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  bandsOf, bandFor, labelFor, replayElo, closingFair, aggregate, LEGACY_EDGES,
} = require('./lib/disagreementFit');
const { ELO_DEFAULT } = require('./lib/elo');

test('bandsOf reproduces the published cuts when asked for no width', () => {
  assert.deepStrictEqual(bandsOf(null), LEGACY_EDGES);
});

test('bandsOf(1) is one band per probability point', () => {
  const edges = bandsOf(1, 40);
  assert.strictEqual(edges.length, 39);
  assert.ok(Math.abs(edges[0] - 0.01) < 1e-12);
  assert.ok(Math.abs(edges[9] - 0.10) < 1e-12);
});

test('A BOUNDARY LANDS IN EXACTLY ONE BAND — closed below, open above', () => {
  // The SQL that built the published rows is `when gap < 0.06 then ...`, so
  // 0.06 belongs to the band ABOVE. A band that admitted it to both would
  // double-count and inflate n on one side.
  const edges = LEGACY_EDGES;
  assert.deepStrictEqual(bandFor(0.06, edges), { min: 0.06, max: 0.10 });
  assert.deepStrictEqual(bandFor(0.0599, edges), { min: 0.03, max: 0.06 });
});

test('the sign of the gap never changes the band', () => {
  // The claim carries the direction; the record is about magnitude.
  for (const g of [0.02, 0.07, 0.12, 0.30]) {
    assert.deepStrictEqual(bandFor(g, LEGACY_EDGES), bandFor(-g, LEGACY_EDGES));
  }
});

test('labels match the spellings the table already holds', () => {
  assert.strictEqual(labelFor({ min: 0, max: 0.03 }), '<3pp');
  assert.strictEqual(labelFor({ min: 0.10, max: 0.15 }), '10-15pp');
  assert.strictEqual(labelFor({ min: 0.15, max: null }), '15pp+');
});

test('A ONE-POINT BAND IS LABELLED AS A POINT, not as a range', () => {
  // "12-13pp" for a band that IS 12pp reads as a range twice its width.
  assert.strictEqual(labelFor({ min: 0.12, max: 0.13 }), '12pp');
});

test('THE PRE-MATCH RATING HAS NOT SEEN ITS OWN RESULT', () => {
  const rows = [
    { id: 1, match_date: '2020-01-01', home_tid: 10, away_tid: 20, ftr: 'H' },
    { id: 2, match_date: '2020-01-08', home_tid: 10, away_tid: 30, ftr: 'H' },
  ];
  const pre = replayElo(rows);
  // Both clubs start at the default in their first fixture.
  assert.strictEqual(pre.get(1).eloHome, ELO_DEFAULT);
  assert.strictEqual(pre.get(1).eloAway, ELO_DEFAULT);
  // By the second, the home win in the first has been applied — and only then.
  assert.ok(pre.get(2).eloHome > ELO_DEFAULT, 'a win must raise the rating');
});

test('the replay is chronological, whatever order the rows arrive in', () => {
  const a = [
    { id: 2, match_date: '2020-01-08', home_tid: 10, away_tid: 30, ftr: 'H' },
    { id: 1, match_date: '2020-01-01', home_tid: 10, away_tid: 20, ftr: 'H' },
  ];
  const b = [a[1], a[0]];
  assert.deepStrictEqual(replayElo(a).get(2), replayElo(b).get(2));
});

test('a draw moves both ratings toward the expectation, not neither', () => {
  const pre = replayElo([
    { id: 1, match_date: '2020-01-01', home_tid: 1, away_tid: 2, ftr: 'D' },
    { id: 2, match_date: '2020-01-02', home_tid: 1, away_tid: 3, ftr: 'D' },
  ]);
  // Home advantage means a draw UNDERPERFORMS the home side's expectation.
  assert.ok(pre.get(2).eloHome < ELO_DEFAULT);
});

test('an unusable result is skipped rather than folded in as a loss', () => {
  const pre = replayElo([
    { id: 1, match_date: '2020-01-01', home_tid: 1, away_tid: 2, ftr: null },
    { id: 2, match_date: '2020-01-02', home_tid: 1, away_tid: 3, ftr: 'H' },
  ]);
  assert.strictEqual(pre.get(2).eloHome, ELO_DEFAULT);
});

test('closingFair refuses an incomplete or invalid price vector', () => {
  assert.strictEqual(closingFair({ PSCH: 2.0, PSCD: 3.4 }), null);
  assert.strictEqual(closingFair({ PSCH: 1.0, PSCD: 3.4, PSCA: 3.6 }), null);
  assert.strictEqual(closingFair(null), null);
  const fair = closingFair({ PSCH: 2.0, PSCD: 3.4, PSCA: 3.6 });
  assert.ok(Array.isArray(fair) && fair.length === 3);
  const sum = fair.reduce((t, p) => t + p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `de-vigged vector must sum to 1 (${sum})`);
});

test('aggregate counts "right" as STRICTLY closer, and ties count for neither', () => {
  const sel = [
    { modelP: 0.60, marketP: 0.40, y: 1 },   // model closer
    { modelP: 0.40, marketP: 0.60, y: 1 },   // market closer
    { modelP: 0.50, marketP: 0.50, y: 1 },   // tie — neither
  ];
  // One band so all three land together.
  const [band] = aggregate(sel, [1]);
  assert.strictEqual(band.n, 3);
  assert.strictEqual(band.model_right_pct, 33.3);
  assert.strictEqual(band.market_right_pct, 33.3);
});

test('every band reports a Brier for both sides', () => {
  const sel = [{ modelP: 0.7, marketP: 0.5, y: 1 }];
  const [band] = aggregate(sel, [1]);
  assert.strictEqual(band.brier_model, round4((0.7 - 1) ** 2));
  assert.strictEqual(band.brier_market, round4((0.5 - 1) ** 2));
});

const round4 = (x) => Math.round(x * 10000) / 10000;

test('per-point banding produces one band per point actually present', () => {
  const sel = [
    { modelP: 0.51, marketP: 0.50, y: 1 },   // 1pp
    { modelP: 0.52, marketP: 0.50, y: 1 },   // 2pp
    { modelP: 0.525, marketP: 0.50, y: 0 },  // 2pp — same band
  ];
  const bands = aggregate(sel, bandsOf(1));
  assert.strictEqual(bands.length, 2);
  assert.deepStrictEqual(bands.map(b => b.gap_bucket), ['1pp', '2pp']);
  assert.deepStrictEqual(bands.map(b => b.n), [1, 2]);
});

test('THE ELO VECTOR IS READ BY ITS REAL FIELD NAMES', () => {
  // eloProbs returns { pHome, pDraw, pAway }. Reading { home, draw, away }
  // yields undefined, the gap becomes NaN, `NaN < edge` is false for every
  // band, and every selection falls through to the open-ended top one — which
  // reported "market 0% / model 0% / brier NaN" over the entire corpus. A
  // wrong field name does not throw; it produces a complete, plausible-shaped,
  // entirely empty scorecard. This asserts the numbers are finite.
  const { selectionsFrom } = require('./lib/disagreementFit');
  const rows = [{
    id: 1, match_date: '2021-01-01', home_tid: 1, away_tid: 2, ftr: 'H',
    odds: { PSCH: 2.0, PSCD: 3.4, PSCA: 3.6 },
    p_home: 0.5, p_draw: 0.27, p_away: 0.23,
  }];
  // minGames 0: this test is about FIELD NAMES, not the maturity cohort, and
  // a single fixture has both clubs on zero prior games.
  const { ELO, DIXON_COLES } = selectionsFrom(rows, {}, { minGames: 0 });
  assert.strictEqual(ELO.length, 3, 'three outcomes');
  assert.strictEqual(DIXON_COLES.length, 3);
  for (const s of ELO) {
    assert.ok(Number.isFinite(s.modelP), `modelP finite (${s.modelP})`);
    assert.ok(s.modelP > 0 && s.modelP < 1, `modelP is a probability (${s.modelP})`);
  }
  const sum = ELO.reduce((t, s) => t + s.modelP, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `the vector sums to one (${sum})`);
});

test('THE ELO COHORT IS THE MATURE ONE, and DIXON_COLES is not filtered', () => {
  // docs/ELO_CALIBRATION.md §8: the fit uses home_games_pre >= 30 and
  // away_games_pre >= 30. Evaluating on a wider cohort than the fit was built
  // for measures a different model — it put the recomputed total at 44,820
  // against the published 38,784. DIXON_COLES has no such notion and must keep
  // every row, or its exact reproduction breaks.
  const { selectionsFrom } = require('./lib/disagreementFit');
  const odds = { PSCH: 2.0, PSCD: 3.4, PSCA: 3.6 };
  const dc = { p_home: 0.5, p_draw: 0.27, p_away: 0.23 };
  // Two clubs meeting repeatedly: the first fixtures are immature, later ones
  // are not. minGames of 2 keeps the fixture small and the intent identical.
  const rows = [];
  for (let i = 1; i <= 5; i++) {
    rows.push({ id: i, match_date: `2021-01-0${i}`, home_tid: 1, away_tid: 2, ftr: 'H', odds, ...dc });
  }
  const { ELO, DIXON_COLES } = selectionsFrom(rows, {}, { minGames: 2 });
  // Fixtures 3, 4, 5 have both clubs on 2+ prior games. 1 and 2 do not.
  assert.strictEqual(ELO.length, 3 * 3, 'only the mature fixtures are evaluated');
  assert.strictEqual(DIXON_COLES.length, 5 * 3, 'every fixture counts for the goals model');
});

test('THE TAIL IS MERGED WHERE THE SAMPLE RUNS OUT', () => {
  const { edgesWithMinSample, aggregate, bandsOf } = require('./lib/disagreementFit');
  // 1pp and 2pp are well sampled; 3pp is thin. Everything from 3pp up merges.
  const sel = [];
  const push = (gapPp, count) => {
    for (let i = 0; i < count; i++) {
      sel.push({ modelP: 0.5 + gapPp / 100, marketP: 0.5, y: i % 2 });
    }
  };
  push(0.5, 50); push(1.5, 40); push(2.5, 3); push(3.5, 2); push(9.5, 1);

  const edges = edgesWithMinSample(sel, 1, 10);
  const bands = aggregate(sel, edges);
  assert.deepStrictEqual(bands.map(b => b.gap_bucket), ['<1pp', '1pp', '2pp+']);
  // The tail is RE-AGGREGATED, not summed from summaries.
  assert.strictEqual(bands[2].n, 6);
  // And the last WELL-SAMPLED point survives rather than being swallowed.
  assert.strictEqual(bands[1].n, 40);
});

test('the tail is re-aggregated, so its rate is not an average of averages', () => {
  const { edgesWithMinSample, aggregate } = require('./lib/disagreementFit');
  // Two thin points with wildly different rates and different sizes. Averaging
  // the two band percentages gives 50%; the true pooled rate is 25%.
  const sel = [];
  for (let i = 0; i < 3; i++) sel.push({ modelP: 0.55, marketP: 0.5, y: 1 });  // model closer
  for (let i = 0; i < 1; i++) sel.push({ modelP: 0.56, marketP: 0.5, y: 0 });  // market closer
  const edges = edgesWithMinSample(sel, 1, 10);
  const bands = aggregate(sel, edges);
  const tail = bands[bands.length - 1];
  assert.strictEqual(tail.n, 4);
  assert.strictEqual(tail.market_right_pct, 25);
});

test('a corpus too thin at EVERY point collapses to one band, not to NaNpp+', () => {
  const { edgesWithMinSample, aggregate } = require('./lib/disagreementFit');
  const sel = [{ modelP: 0.55, marketP: 0.5, y: 1 }];
  const edges = edgesWithMinSample(sel, 1, 10);
  const bands = aggregate(sel, edges);
  assert.strictEqual(bands.length, 1);
  // The merge starts at the lowest OCCUPIED thin band (5pp here), so the
  // empty points below it keep their edges and the tail is '5pp+'.
  assert.strictEqual(bands[0].gap_bucket, '5pp+');
  assert.ok(!String(bands[0].gap_bucket).includes('NaN'));
});

test('a well-sampled corpus keeps every point — the floor only ever merges', () => {
  const { edgesWithMinSample, bandsOf } = require('./lib/disagreementFit');
  const sel = [];
  for (let pp = 0; pp < 5; pp++) {
    for (let i = 0; i < 100; i++) sel.push({ modelP: 0.5 + (pp + 0.5) / 100, marketP: 0.5, y: i % 2 });
  }
  assert.deepStrictEqual(edgesWithMinSample(sel, 1, 10), bandsOf(1));
});

test('MARKET_ANCHORED is sharp-vs-consensus, with no forecast in it', () => {
  const { selectionsFrom } = require('./lib/disagreementFit');
  const row = {
    id: 1, match_date: '2021-01-01', home_tid: 1, away_tid: 2, ftr: 'H',
    // Pinnacle shorter on the home side than the crowd — the architecture's
    // own claim, that the sharp book has it right and the crowd has not.
    odds: { PSCH: 2.00, PSCD: 3.40, PSCA: 3.60, AvgCH: 2.20, AvgCD: 3.30, AvgCA: 3.40 },
    p_home: 0.5, p_draw: 0.27, p_away: 0.23,
  };
  const { MARKET_ANCHORED } = selectionsFrom([row], {}, { minGames: 0 });
  assert.strictEqual(MARKET_ANCHORED.length, 3);
  // The MODEL side is Pinnacle de-vigged; the MARKET side is the consensus.
  // Pinnacle is shorter on home, so its probability must be the higher one.
  assert.ok(MARKET_ANCHORED[0].modelP > MARKET_ANCHORED[0].marketP,
    'the sharp book is the model side');
  for (const s of MARKET_ANCHORED) {
    assert.ok(Number.isFinite(s.modelP) && Number.isFinite(s.marketP));
  }
  const mSum = MARKET_ANCHORED.reduce((t, s) => t + s.modelP, 0);
  const kSum = MARKET_ANCHORED.reduce((t, s) => t + s.marketP, 0);
  assert.ok(Math.abs(mSum - 1) < 1e-9, `model vector sums to one (${mSum})`);
  assert.ok(Math.abs(kSum - 1) < 1e-9, `market vector sums to one (${kSum})`);
});

test('MARKET_ANCHORED is SKIPPED when the consensus is missing, never faked', () => {
  const { selectionsFrom } = require('./lib/disagreementFit');
  const row = {
    id: 1, match_date: '2021-01-01', home_tid: 1, away_tid: 2, ftr: 'H',
    odds: { PSCH: 2.0, PSCD: 3.4, PSCA: 3.6 },   // no AvgC* at all
    p_home: 0.5, p_draw: 0.27, p_away: 0.23,
  };
  const out = selectionsFrom([row], {}, { minGames: 0 });
  assert.strictEqual(out.MARKET_ANCHORED.length, 0);
  // The forecasting models still measure — one model's missing input must not
  // cost the others their rows.
  assert.strictEqual(out.DIXON_COLES.length, 3);
  assert.strictEqual(out.ELO.length, 3);
});

// ── calibrationSigma — VERIFIED AGAINST THE SQL, not argued to match it ──────
//
// The estimator is migration 048's `calibration_report()` expression. The two
// cases below are that expression's OWN OUTPUT, run against production
// `value_signals` on 21 Aug 2026 and reconstructed exactly:
//
//     API_PREDICTIVE   n=281  bins=3  sigma 0.0000
//     LAMBDA_MC        n=166  bins=4  sigma 0.0751
//
// API_PREDICTIVE exercises the whole path — it holds five distinct
// probabilities, so the (p, won, count) triples rebuild all 281 rows without
// loss and the binning runs for real. LAMBDA_MC is the arithmetic: it is the
// ONE architecture whose sigma is neither zero nor floored, so it is the only
// case where getting the binomial-variance subtraction wrong would show up.

/** Expand (p, won, count) triples into individual selections. */
function expand(triples) {
  const out = [];
  for (const [p, y, n] of triples) for (let i = 0; i < n; i++) out.push({ modelP: p, y });
  return out;
}

test('calibrationSigma reproduces API_PREDICTIVE — 281 rows, 3 bins, 0.0000', () => {
  const { calibrationSigma } = require('./lib/disagreementFit');
  const rows = expand([
    [0.10, 0, 18], [0.10, 1, 1],
    [0.30, 0, 27], [0.30, 1, 6],
    [0.33, 0, 27], [0.33, 1, 22],
    [0.35, 0, 10], [0.35, 1, 5],
    [0.45, 0, 91], [0.45, 1, 74],
  ]);
  assert.strictEqual(rows.length, 281);
  const r = calibrationSigma(rows);
  assert.strictEqual(r.nUsed, 281);
  assert.strictEqual(r.nBins, 3);
  // A ZERO IS A RESULT, not a failure. Its "model probability" is a five-value
  // lookup keyed to price bands, and a lookup that tracks the price cannot
  // miscalibrate. That is why model_calibration carries a FLOOR for this
  // family and says so in sigma_source.
  assert.strictEqual(Number(r.sigmaHat.toFixed(4)), 0);
});

test('calibrationSigma reproduces LAMBDA_MC — 166 rows, 4 bins, 0.0751', () => {
  const { calibrationSigma } = require('./lib/disagreementFit');
  // The bin summary the SQL produced, rebuilt: n rows at p_bar with
  // round(obs * n) winners, which is exact here — 7, 21, 9 and 0.
  const bins = [
    [36, 0.181825, 0.194444], [94, 0.252659, 0.223404],
    [30, 0.319480, 0.300000], [6, 0.523317, 0.000000],
  ];
  const rows = [];
  for (const [n, pBar, obs] of bins) {
    const wins = Math.round(obs * n);
    for (let i = 0; i < n; i++) rows.push({ modelP: pBar, y: i < wins ? 1 : 0 });
  }
  const r = calibrationSigma(rows);
  assert.strictEqual(r.nUsed, 166);
  assert.strictEqual(r.nBins, 4);
  assert.strictEqual(Number(r.sigmaHat.toFixed(4)), 0.0751);
});

test('calibrationSigma subtracts sampling noise rather than reporting raw miss', () => {
  const { calibrationSigma } = require('./lib/disagreementFit');
  // A perfectly calibrated model still misses at a finite sample. 400 rows at
  // p = 0.5 with exactly 200 winners is the noiseless case and must read zero;
  // the uncorrected miss would not, and every model would then measure a sigma
  // made of its own sample size.
  const rows = Array.from({ length: 400 }, (_, i) => ({ modelP: 0.5, y: i < 200 ? 1 : 0 }));
  assert.strictEqual(calibrationSigma(rows).sigmaHat, 0);
});

test('calibrationSigma drops thin bins and refuses outright when none survive', () => {
  const { calibrationSigma } = require('./lib/disagreementFit');
  const r = calibrationSigma([{ modelP: 0.2, y: 1 }, { modelP: 0.9, y: 0 }]);
  assert.strictEqual(r.sigmaHat, null);
  assert.strictEqual(r.nUsed, 0);
  assert.strictEqual(r.nBins, 0);
});
