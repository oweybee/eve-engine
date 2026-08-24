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
const { scoreSignal, maxedgeScore, sigmaFor, bandFor,
        edgeEfficiency, EDGE_EFFICIENCY } = require('./lib/maxedge');
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
  { gap: 0.0300, sigma: 0.0300, mxs: 65, band: 'PRIME' }, // z = 1 → the boundary
  { gap: 0.0150, sigma: 0.0300, mxs: 41, band: 'WATCH' },
  { gap: 0.0100, sigma: 0.0300, mxs: 30, band: 'SLIGHT' },
  { gap: 0.0600, sigma: 0.0300, mxs: 88, band: 'PRIME' },
  { gap: 0.1000, sigma: 0.0300, mxs: 97, band: 'PRIME' },
  { gap: 0.0300, sigma: 0.0693, mxs: 37, band: 'SLIGHT' },
  { gap: 0.0000, sigma: 0.0300, mxs: 0,  band: 'NIL' },
  { gap: -0.020, sigma: 0.0300, mxs: 0,  band: 'NIL' },
  { gap: 0.0530, sigma: 0.0530, mxs: 65, band: 'PRIME' },
  { gap: 0.0693, sigma: 0.0693, mxs: 65, band: 'PRIME' },
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

// 0.38 is a plausible de-vigged probability for a 2.50 shot: the raw reciprocal
// is 0.4000, and removing ~3.4% of residual panel margin lands just under it.
// The gap it produces is BIGGER than the old `edge/odds`, which is the point.
const row = (over = {}) => ({
  detected_odds: 2.50, detected_edge: 0.08, market_prob: 0.38,
  model_architecture: 'DIXON_COLES', ...over,
});

test('the market side is the de-vigged probability it was handed', () => {
  const s = scoreSignal(row());
  //  p_market = 0.3800 (de-vigged, supplied) ; p_model = 1.08/2.50 = 0.4320
  assert.strictEqual(s.market_prob, 0.38);
  assert.strictEqual(s.model_prob, 0.432);
  assert.ok(Math.abs(s.prob_gap - 0.052) < 1e-9);
});

test('de-vigging WIDENS the gap — the sign the old note had backwards', () => {
  // The whole justification for the change, pinned as arithmetic. `1/odds`
  // sums to more than one across a market, so it overstates each outcome and
  // shrinks the disagreement. A de-vigged market probability is SMALLER, so the
  // gap is BIGGER and the score is HIGHER — not "inflated by the vig" as the
  // frontend mirror's note claimed.
  const devigged = scoreSignal(row());                       // p_market 0.3800
  const implied  = scoreSignal(row({ market_prob: 1 / 2.5 })); // p_market 0.4000
  assert.ok(devigged.prob_gap > implied.prob_gap);
  assert.ok(devigged.mxs > implied.mxs);
  // And the old convention's gap was exactly edge/odds — the identity that made
  // prob_gap a restatement of the price rather than a measurement.
  assert.ok(Math.abs(implied.prob_gap - 0.08 / 2.5) < 1e-9);
});

test('no de-vigged market probability, no verdict — it does NOT fall back to 1/odds', () => {
  // The fail-closed rule. A silent `1/odds` fallback would put two conventions
  // back in one column with nothing saying which is which, which is exactly what
  // gap_basis exists to prevent.
  for (const mp of [undefined, null, '', 0, 1, 1.4, -0.2, NaN, 'abc']) {
    const s = scoreSignal(row({ market_prob: mp }));
    assert.strictEqual(s.mxs, null, `market_prob ${mp}`);
    assert.strictEqual(s.market_prob, null, `market_prob ${mp}`);
    assert.strictEqual(s.prob_gap, null, `market_prob ${mp}`);
    assert.strictEqual(s.gap_basis, null, `market_prob ${mp}`);
  }
});

test('stamps the convention on every row it scores', () => {
  assert.strictEqual(scoreSignal(row()).gap_basis, 'devigged');
  // Even where sigma is null and there is no score: the gap IS measured and
  // stored on those rows, so what it was measured against has to be too.
  assert.strictEqual(
    scoreSignal(row({ model_architecture: 'SUPERMODEL_HALFTIME' })).gap_basis, 'devigged');
});

test('prefers a model probability the caller actually holds', () => {
  const s = scoreSignal(row({ model_prob: 0.51 }));
  assert.strictEqual(s.model_prob, 0.51);
  assert.ok(Math.abs(s.prob_gap - 0.13) < 1e-9);
});

test('rounds both probabilities to fit numeric(6,4)', () => {
  const s = scoreSignal(row({ detected_odds: 3.7, detected_edge: 0.123456789 }));
  for (const v of [s.model_prob, s.market_prob]) {
    assert.ok(String(v).split('.')[1].length <= 4, `${v} fits numeric(6,4)`);
  }
});

test('writes the band beside the score, from the score', () => {
  // Both cases carry a de-vigged probability consistent with their OWN price:
  // 0.4830 against a raw 1/2.00 = 0.5000. A market probability that does not
  // belong to the odds beside it is not a weaker test, it is a different bet.
  const at2 = { detected_odds: 2.0, market_prob: 0.483 };
  // EDGE 0.06 — THE PLATEAU. This case carried 0.20 until 21 Aug 2026, when the
  // edge was not an input to the score; f(edge) now files a 20% edge in the
  // TRAP ZONE at 0.25, so the row it was written to demonstrate (a big gap that
  // IS backed) has to be priced where the score survives. The de-vigged
  // probability and the price are untouched.
  const s = scoreSignal(row({ ...at2, detected_edge: 0.06 }));
  assert.strictEqual(s.mxs_band, bandFor(s.mxs));
  assert.strictEqual(isBacked(s.mxs), true);
  assert.ok(s.mxs >= 65);
  assert.strictEqual(s.mxs, s.mxs_raw, 'the plateau keeps the whole score');
  assert.strictEqual(s.mes_efficiency, 1);

  const weak = scoreSignal(row({ ...at2, detected_edge: 0.02 }));
  assert.strictEqual(weak.mxs_band, bandFor(weak.mxs));
  assert.strictEqual(isBacked(weak.mxs), false);

  // AND THE BAND IS CUT FROM THE FINAL SCORE, which is the whole change: the
  // 20% row keeps its raw disagreement and loses three quarters of its shown
  // score, so the rung the engine STORES agrees with the number it stores
  // beside it. A stored band disagreeing with a stored score is the conflict
  // this removes.
  const trap = scoreSignal(row({ ...at2, detected_edge: 0.20 }));
  assert.strictEqual(trap.mes_efficiency, 0.25);
  assert.strictEqual(trap.mxs, Math.round(trap.mxs_raw * 0.25));
  assert.strictEqual(trap.mxs_band, bandFor(trap.mxs));
  assert.strictEqual(isBacked(trap.mxs), false);
  assert.ok(trap.mxs_raw >= 65, 'the raw disagreement is still a big one');
  assert.strictEqual(trap.mes_basis, 'edge_adjusted');
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
  assert.strictEqual(s.market_prob, 0.38);
});

test('a price that cannot be a price scores nothing at all', () => {
  for (const odds of [1, 0, -2, null, undefined, NaN]) {
    const s = scoreSignal(row({ detected_odds: odds }));
    assert.strictEqual(s.mxs, null, `odds ${odds}`);
    assert.strictEqual(s.model_prob, null, `odds ${odds}`);
  }
});

test('the columns it emits are 048’s, plus 039’s two, 058’s gap_basis and 090’s three', () => {
  // THE COLUMN LIST IS A CONTRACT WITH THE DATABASE and this assertion is what
  // makes it one: migration 090 has to land BEFORE the engine deploys, or every
  // insert fails on three unknown columns. A test that only checked the score
  // would go green on a schema that cannot accept the row.
  assert.deepStrictEqual(Object.keys(scoreSignal(row())).sort(),
    ['gap_basis', 'market_prob', 'mes_basis', 'mes_efficiency', 'model_prob',
     'model_sigma', 'mxs', 'mxs_band', 'mxs_raw', 'prob_gap']);
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
    // `range` is here because the history pre-filters are PAGED now — a
    // PostgREST response is capped at 1,000 rows, so an unpaged pre-filter
    // silently stops catching collisions once a match set gets big enough.
    // A stub missing this reports the paging as a TypeError, not as a miss.
    range: () => q,
    then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    // Accepts a batch OR a single row: `insertSignals` falls back to row-by-row
    // when the unique index rejects a batch.
    insert: (batch) => {
      rows.push(...(Array.isArray(batch) ? batch : [batch]));
      return Promise.resolve({ error: null });
    },
  };
  return { rows, from: () => q };
}

const SCORED = ['model_prob', 'market_prob', 'prob_gap', 'model_sigma', 'mxs', 'mxs_band', 'gap_basis'];

/* ── f(edge), and it must MIRROR the browser and the database ───────────── */
//
// Three implementations of one curve: here, eve-frontend/lib/maxedge.ts, and
// public.edge_efficiency() from migration 090. A score the engine stores and a
// score the browser derives for one row have to be the same number, and the
// `MODEL_SIGMA` hand-copy is what happens when they are not — it failed twice
// in production and neither copy threw. The same three cases are asserted in
// the migration and in lib/maxedge.test.ts, so a drift in any one shows up.

test('f(edge) reproduces the three cases the brief states', () => {
  assert.strictEqual(edgeEfficiency(0.075), 1);
  assert.ok(Math.abs(edgeEfficiency(0.101) - 0.6375) < 1e-9, `got ${edgeEfficiency(0.101)}`);
  assert.strictEqual(Math.round(80 * edgeEfficiency(0.101)), 51);
  assert.strictEqual(edgeEfficiency(0.158), 0.25);
  assert.strictEqual(Math.round(80 * edgeEfficiency(0.158)), 20);
});

test('f(edge) never lets an edge over 10% reach the PRIME line', () => {
  // 65 / 0.65 = 100 and maxedgeScore caps the raw score at 99, so this is a
  // theorem rather than an observation about today's rows. Walked over every
  // (raw, edge) pair the scorer can produce.
  for (let bp = 1001; bp <= 3000; bp++) {
    const e = bp / 10000;
    for (let raw = 0; raw <= 99; raw++) {
      const final = Math.round(raw * edgeEfficiency(e));
      assert.ok(final < 65, `raw ${raw} at edge ${e} scored ${final}`);
    }
  }
});

test('f(edge) is a decay, never a boost, and never zero', () => {
  for (let bp = -500; bp <= 5000; bp++) {
    const f = edgeEfficiency(bp / 10000);
    assert.ok(f > 0 && f <= 1, `f(${bp / 10000}) = ${f}`);
  }
  // An unknown edge asserts nothing rather than inventing a penalty.
  assert.strictEqual(edgeEfficiency(null), 1);
  assert.strictEqual(edgeEfficiency(undefined), 1);
});

test('the knee sits exactly where the guarantee needs it', () => {
  // Soften this to make a PRIME appear above a 10% edge and the theorem above
  // goes with it — so the constant is pinned rather than inferred.
  assert.strictEqual(EDGE_EFFICIENCY.knee, 0.65);
  assert.strictEqual(EDGE_EFFICIENCY.kneeAt, 0.10);
  assert.ok(Math.round(99 * EDGE_EFFICIENCY.knee) < 65);
});

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
    // The de-vigged panel probability computeMatch now carries onto the row.
    // 0.4400 against a raw 1/2.20 = 0.4545 — the residual margin, removed.
    _mktDevig: { home: 0.44, draw: null, away: null },
  }], 'prematch', 'MARKET_ANCHORED');

  test('the 1X2 path writes every scored column', () => {
    assert.strictEqual(c1.rows.length, 1);
    for (const col of SCORED) assert.ok(col in c1.rows[0], `${col} is written`);
    assert.strictEqual(c1.rows[0].market_prob, 0.44);
    assert.strictEqual(c1.rows[0].gap_basis, 'devigged');
    assert.strictEqual(c1.rows[0].mxs, 86);
    assert.strictEqual(c1.rows[0].mxs_band, bandFor(c1.rows[0].mxs));
    // Both ladders on one row, and they are allowed to differ. The eligibility
    // bucket is LOWER CASE — it is a key, not the badge word the conviction
    // ladder prints. See the note on categoryFor in lib/signalTier.js, and the
    // CHECK constraint on value_signals, which admits only these three.
    assert.strictEqual(c1.rows[0].signal_category, 'prime');
    assert.strictEqual(c1.rows[0].signal_category,
      c1.rows[0].signal_category.toLowerCase());
  });

  // The same row with no de-vigged probability to hand: it must still be
  // INSERTED, carrying no verdict. Losing a signal because the panel was
  // incomplete would be a worse failure than not scoring it.
  const c1b = captureClient();
  await insertValueSignals(c1b, [{
    match_id: '00000000-0000-0000-0000-000000000003',
    home_value: true, home_edge: 0.09,
    best_home_odds: 2.20, best_home_book: 'bet365',
    all_home_odds: { bet365: 2.20, pinnacle: 2.14, williamhill: 2.10, unibet: 2.12 },
    _bookmakerCount: 18,
    odds_fetched_at: new Date().toISOString(),
    _kickoff_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
    _mktDevig: { home: null, draw: null, away: null },
  }], 'prematch', 'MARKET_ANCHORED');

  test('an un-de-viggable panel still writes the row, with a null verdict', () => {
    assert.strictEqual(c1b.rows.length, 1, 'the signal is not lost');
    assert.strictEqual(c1b.rows[0].mxs, null);
    assert.strictEqual(c1b.rows[0].market_prob, null);
    assert.strictEqual(c1b.rows[0].gap_basis, null);
  });

  const c2 = captureClient();
  await insertSecondarySignals(c2, [{
    match_id: '00000000-0000-0000-0000-000000000002',
    outcome: 'over', market: 'totals', market_line: 2.5,
    detected_odds: 1.91, detected_edge: 0.048,
    bookmaker: 'bet365', model_architecture: 'DIXON_COLES', model_prob: 0.5487,
    // Shin-de-vigged P(over) from the two-way pair, as lib/secondaryMarkets now
    // attaches it. 0.5200 against a raw 1/1.91 = 0.5236.
    market_prob: 0.52,
    kickoff_at: new Date(Date.now() + 9 * 3600e3).toISOString(),
  }], 'prematch');

  test('the secondary path writes them too, and no longer throws', () => {
    assert.strictEqual(c2.rows.length, 1, 'it inserted rather than throwing');
    for (const col of SCORED) assert.ok(col in c2.rows[0], `${col} is written`);
    assert.strictEqual(c2.rows[0].market_prob, 0.52);
    assert.strictEqual(c2.rows[0].gap_basis, 'devigged');
    assert.strictEqual(c2.rows[0].mxs, 63);
    assert.strictEqual(c2.rows[0].mxs_band, 'WATCH');
  });

  test('the secondary path keeps the model probability it was handed', () => {
    // It used to be destructured away on the claim that it was not a column.
    assert.strictEqual(c2.rows[0].model_prob, 0.5487);
  });

  
test('the plateau starts at 3% — mirrors eve-frontend/lib/maxedge.ts', () => {
  // Loosened 4% -> 3% on 22 Aug. This file is the ENGINE half of a mirrored
  // constant, and a mirror nobody tests is the MODEL_SIGMA hand-copy again —
  // it failed twice in production without either copy throwing.
  assert(Math.abs(edgeEfficiency(0.015) - 0.75) < 1e-9, 'halfway up the ramp');
  assert(edgeEfficiency(0.03) === 1, '3% keeps the whole score');
  assert(edgeEfficiency(0.0332) === 1, 'the 3-4% band is on the plateau now');
  assert(Math.abs(edgeEfficiency(0.0247) - 0.9117) < 1e-3, 'the ramp still exists below 3%');
  // The high side is untouched: the guarantee rests on these, not on the ramp.
  assert(Math.abs(edgeEfficiency(0.10) - 0.65) < 1e-9, 'knee unmoved');
  assert(edgeEfficiency(0.1201) === 0.25, 'trap floor unmoved');
});

console.log(`\n  ${passed} passed`);
})();
