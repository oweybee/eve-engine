/**
 * engine.maxedge.test.js — the score the engine now freezes at detection.
 * Run: node engine.maxedge.test.js
 *
 * The formula exists in three places (SQL in migration 048, the frontend, and
 * lib/maxedge.js) with no shared package between them. The GOLDEN cases below
 * were read out of the applied database — `select maxedge_score(gap, sigma)` on
 * production — so this file is the thing that keeps the copies honest rather
 * than a restatement of the same arithmetic.
 */
'use strict';
const assert = require('assert');
const { scoreSignal, maxedgeScore, sigmaFor, bandFor } = require('./lib/maxedge');
const { isBacked } = require('./lib/signalTier');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

/* ── The formula, against values the DATABASE produced ─────────────────── */

// select maxedge_score(gap, sigma) from (values ...) — run on production
// zlbmpeiuhyllxwegtayu, 6 Aug 2026. If these drift, the browser, the engine and
// the database are no longer computing one number.
//
// THE SCORES DID NOT MOVE IN THE SIX-RUNG RE-CUT — only the words. That two of
// these pairs already landed on exactly 88 and exactly 41 is not a coincidence:
// those are 2σ and 0.5σ, which is where the new cutoffs were derived from. The
// table was computing the boundaries before anyone named them.
const GOLDEN = [
  { gap: 0.0300, sigma: 0.0300, mxs: 65, band: 'STRONG' }, // z = 1 → the boundary
  { gap: 0.0150, sigma: 0.0300, mxs: 41, band: 'WATCH' },
  { gap: 0.0100, sigma: 0.0300, mxs: 30, band: 'SLIGHT' },
  { gap: 0.0600, sigma: 0.0300, mxs: 88, band: 'PRIME' },
  { gap: 0.1000, sigma: 0.0300, mxs: 97, band: 'PRIME' },
  { gap: 0.0300, sigma: 0.0693, mxs: 37, band: 'SLIGHT' },
  { gap: 0.0000, sigma: 0.0300, mxs: 0,  band: 'NIL' },
  { gap: -0.020, sigma: 0.0300, mxs: 0,  band: 'NIL' },
  { gap: 0.0530, sigma: 0.0530, mxs: 65, band: 'STRONG' },
  { gap: 0.0693, sigma: 0.0693, mxs: 65, band: 'STRONG' },
];

test('matches maxedge_score() on every golden pair', () => {
  // Three of these were guessed wrong when this file was first written (40 for
  // 41, 29 for 30, 98 for 97) and the database corrected them. That is the
  // entire argument for reading the goldens out of the applied schema instead
  // of restating the arithmetic the implementation already does.
  for (const g of GOLDEN) {
    assert.strictEqual(maxedgeScore(g.gap, g.sigma), g.mxs,
      `gap ${g.gap} sigma ${g.sigma}`);
  }
});

test('matches maxedge_band() on every golden pair too', () => {
  for (const g of GOLDEN) {
    assert.strictEqual(bandFor(maxedgeScore(g.gap, g.sigma)), g.band,
      `gap ${g.gap} sigma ${g.sigma}`);
  }
});

test('65 is the boundary by construction, not by choice', () => {
  // At z = z_gate the expression is 1 − 0.35, which is 0.65 exactly. Nothing
  // in the code picks 65; changing the base moves it.
  for (const sigma of [0.03, 0.0530, 0.0693, 0.12]) {
    assert.strictEqual(maxedgeScore(sigma, sigma), 65, `sigma ${sigma}`);
  }
});

test('100 is unreachable — it would require infinite certainty', () => {
  assert.strictEqual(maxedgeScore(10, 0.03), 99);
});

test('an unmeasurable input scores nothing, never zero', () => {
  for (const bad of [null, undefined, NaN, 'x']) {
    assert.strictEqual(maxedgeScore(bad, 0.03), null, String(bad));
    assert.strictEqual(maxedgeScore(0.03, bad), null, String(bad));
  }
  assert.strictEqual(maxedgeScore(0.03, 0), null, 'a zero sigma is not an error bar');
});

/* ── The sigma mirror ──────────────────────────────────────────────────── */

test('carries MARKET_ANCHORED, which migration 048 does not seed', () => {
  // It was added to model_calibration after 048 shipped. Reading the migration
  // rather than the table is how the frontend came to be missing it, which made
  // the one architecture the owner had enabled the one that scored null.
  assert.strictEqual(sigmaFor('MARKET_ANCHORED'), 0.03);
  assert.strictEqual(sigmaFor('DIXON_COLES'), 0.03);
  assert.strictEqual(sigmaFor('MARKET_CONSENSUS'), 0.0693);
});

test('an architecture nobody has measured gets no sigma and no score', () => {
  assert.strictEqual(sigmaFor('SUPERMODEL_HALFTIME'), null);
  assert.strictEqual(sigmaFor(null), null);
  assert.strictEqual(sigmaFor(undefined), null);
});

/* ── Scoring a whole row ───────────────────────────────────────────────── */

const row = (over = {}) => ({
  detected_odds: 2.50, detected_edge: 0.08,
  model_architecture: 'DIXON_COLES', ...over,
});

test('recovers the two probabilities the way 048 backfills them', () => {
  const s = scoreSignal(row());
  //  p_market = 1/2.50 = 0.4000 ; p_model = 1.08/2.50 = 0.4320
  assert.strictEqual(s.market_prob, 0.4);
  assert.strictEqual(s.model_prob, 0.432);
  assert.ok(Math.abs(s.prob_gap - 0.032) < 1e-9);
});

test('prefers a model probability the caller actually holds', () => {
  const s = scoreSignal(row({ model_prob: 0.51 }));
  assert.strictEqual(s.model_prob, 0.51);
  assert.ok(Math.abs(s.prob_gap - 0.11) < 1e-9);
});

test('rounds both probabilities to fit numeric(6,4)', () => {
  const s = scoreSignal(row({ detected_odds: 3.7, detected_edge: 0.123456789 }));
  for (const v of [s.model_prob, s.market_prob]) {
    assert.ok(String(v).split('.')[1].length <= 4, `${v} fits numeric(6,4)`);
  }
});

test('writes the band beside the score, from the score', () => {
  const s = scoreSignal(row({ detected_odds: 2.0, detected_edge: 0.20 }));
  assert.strictEqual(s.mxs_band, bandFor(s.mxs));
  assert.strictEqual(isBacked(s.mxs), true);
  assert.ok(s.mxs >= 65);
  const weak = scoreSignal(row({ detected_odds: 2.0, detected_edge: 0.02 }));
  assert.strictEqual(weak.mxs_band, bandFor(weak.mxs));
  assert.ok(weak.mxs >= 25 && weak.mxs < 40);
});

test('an unmeasured architecture yields nulls, and does NOT lose the row', () => {
  // Every field null, no throw: an unscorable signal is still a signal, it just
  // carries no verdict. Losing the insert over it would be worse.
  const s = scoreSignal(row({ model_architecture: 'SUPERMODEL_HALFTIME' }));
  assert.strictEqual(s.mxs, null);
  assert.strictEqual(s.mxs_band, null);
  assert.strictEqual(s.model_sigma, null);
  // The probabilities are still recoverable and still written — they are facts
  // about the row, not a claim about its strength.
  assert.strictEqual(s.market_prob, 0.4);
});

test('a price that cannot be a price scores nothing at all', () => {
  for (const odds of [1, 0, -2, null, undefined, NaN]) {
    const s = scoreSignal(row({ detected_odds: odds }));
    assert.strictEqual(s.mxs, null, `odds ${odds}`);
    assert.strictEqual(s.model_prob, null, `odds ${odds}`);
  }
});

test('the columns it emits are exactly the ones 048 added, plus 039’s two', () => {
  assert.deepStrictEqual(Object.keys(scoreSignal(row())).sort(),
    ['market_prob', 'model_prob', 'model_sigma', 'mxs', 'mxs_band', 'prob_gap']);
});

/* ── The write paths actually emit it ──────────────────────────────────── */

// scoreSignal working is not the same as the engine WRITING the score, and the
// difference was a live crash: insertSecondarySignals threw
// `ReferenceError: rejected is not defined` on its first candidate, so no
// totals/BTTS/corners/cards signal was written for seven hours on 6 Aug. These
// drive the real functions with a stub client and read what they would send.

const { insertValueSignals, insertSecondarySignals } = require('./computeValues');

function captureClient() {
  const rows = [];
  const q = {
    select: () => q, in: () => q, eq: () => q, gt: () => q, gte: () => q,
    lte: () => q, order: () => q, limit: () => q, not: () => q, is: () => q,
    then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    insert: (batch) => { rows.push(...batch); return Promise.resolve({ error: null }); },
  };
  return { rows, from: () => q };
}

const SCORED = ['model_prob', 'market_prob', 'prob_gap', 'model_sigma', 'mxs', 'mxs_band'];

(async () => {
  const c1 = captureClient();
  await insertValueSignals(c1, [{
    match_id: '00000000-0000-0000-0000-000000000001',
    home_value: true, home_edge: 0.09,
    best_home_odds: 2.20, best_home_book: 'bet365',
    all_home_odds: { bet365: 2.20, pinnacle: 2.14, williamhill: 2.10, unibet: 2.12 },
    _bookmakerCount: 18,
    odds_fetched_at: new Date().toISOString(),
    _kickoff_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
  }], 'prematch', 'MARKET_ANCHORED');

  test('the 1X2 path writes every scored column', () => {
    assert.strictEqual(c1.rows.length, 1);
    for (const col of SCORED) assert.ok(col in c1.rows[0], `${col} is written`);
    assert.strictEqual(c1.rows[0].mxs, 76);
    assert.strictEqual(c1.rows[0].mxs_band, bandFor(c1.rows[0].mxs));
    // Both ladders on one row, and they are allowed to differ.
    assert.strictEqual(c1.rows[0].signal_category, 'Prime');
  });

  const c2 = captureClient();
  await insertSecondarySignals(c2, [{
    match_id: '00000000-0000-0000-0000-000000000002',
    outcome: 'over', market: 'totals', market_line: 2.5,
    detected_odds: 1.91, detected_edge: 0.048,
    bookmaker: 'bet365', model_architecture: 'DIXON_COLES', model_prob: 0.5487,
    kickoff_at: new Date(Date.now() + 9 * 3600e3).toISOString(),
  }], 'prematch');

  test('the secondary path writes them too, and no longer throws', () => {
    assert.strictEqual(c2.rows.length, 1, 'it inserted rather than throwing');
    for (const col of SCORED) assert.ok(col in c2.rows[0], `${col} is written`);
    assert.strictEqual(c2.rows[0].mxs, 59);
    assert.strictEqual(c2.rows[0].mxs_band, 'WATCH');
  });

  test('the secondary path keeps the model probability it was handed', () => {
    // It used to be destructured away on the claim that it was not a column.
    assert.strictEqual(c2.rows[0].model_prob, 0.5487);
  });

  console.log(`\n  ${passed} passed`);
})();
