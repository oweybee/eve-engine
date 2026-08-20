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
