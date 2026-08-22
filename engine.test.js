'use strict';

/**
 * engine.test.js — unit tests for the Market-Consensus value engine.
 *
 * Zero deps, no DB / network. Exercises the two pure exports of
 * computeValues.js:
 *   • computeConsensus(oddsRows) — dedup → outlier drop → de-vig → edge
 *   • computeMatch(match)        — the computed_values row builder
 *
 * (The previous version of this file imported ./computeValues.v2 and a set of
 * granular helpers — computeEV/computeEdge/deVig/impliedProb — that no longer
 * exist: that logic was folded into computeConsensus in the v7 refactor, so the
 * suite crashed at require() and covered nothing. These tests target the current
 * API.)
 */

const assert = require('assert');
const { computeConsensus, computeMatch } = require('./computeValues');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

// Fresh timestamp so the ODDS_MAX_AGE_HOURS staleness guard never trips.
const NOW = new Date().toISOString();
const HOURS_AGO = h => new Date(Date.now() - h * 3_600_000).toISOString();

// Build an h2h odds row. Distinct bookmaker names so the per-book dedup keeps them.
const row = (bookmaker, home, draw, away, fetched_at = NOW) =>
  ({ bookmaker, market: 'h2h', home_odds: home, draw_odds: draw, away_odds: away, fetched_at });

// ── computeConsensus: guard conditions ───────────────────────────────────────
console.log('\ncomputeConsensus — guards');
test('no h2h rows → null', () => assert.strictEqual(computeConsensus([]), null));
test('below MIN_BOOKMAKERS (1 book) → null', () =>
  assert.strictEqual(computeConsensus([row('bet365', 2.0, 3.5, 4.0)]), null));
test('stale odds (25h old) → null', () =>
  assert.strictEqual(computeConsensus([
    row('bet365',   2.0, 3.5, 4.0, HOURS_AGO(25)),
    row('pinnacle', 2.0, 3.5, 4.0, HOURS_AGO(25)),
  ]), null));

// ── computeConsensus: de-vig invariant ───────────────────────────────────────
console.log('\ncomputeConsensus — de-vig');
test('de-vigged consensus probs sum to 1', () => {
  const c = computeConsensus([
    row('bet365',   2.0, 3.6, 4.0),
    row('pinnacle', 2.05, 3.5, 3.9),
  ]);
  const sum = c.home.p_cons + c.draw.p_cons + c.away.p_cons;
  assert.ok(Math.abs(sum - 1) < 1e-9, `expected ~1, got ${sum}`);
});
test('fair odds are positive and finite on a vigged book', () => {
  const c = computeConsensus([
    row('bet365',   2.0, 3.6, 4.0),
    row('pinnacle', 2.0, 3.6, 4.0),
  ]);
  assert.ok(c.home.fair_odds > 0 && c.draw.fair_odds > 0 && c.away.fair_odds > 0);
});

// ── computeConsensus: edge detection ─────────────────────────────────────────
console.log('\ncomputeConsensus — edge detection');
test('a genuinely long best price flags a plausible edge', () => {
  const c = computeConsensus([
    row('bet365',      2.10, 3.60, 3.70),
    row('pinnacle',    2.10, 3.60, 3.70),   // the anchor
    row('williamhill', 2.35, 3.50, 3.60),   // best home price, at a BETTABLE book
  ]);
  assert.strictEqual(c.home.has_edge, true, 'home should have edge');
  assert.strictEqual(c.home.max_odds, 2.35, 'best home odds should be 2.35');
  assert.ok(c.home.edge > 0 && c.home.edge < 0.30, `edge out of range: ${c.home.edge}`);
  // Internal consistency: edge == p_adj * best_odds - 1 (cross-checks two fields)
  const recomputed = c.home.p_adj * c.home.max_odds - 1;
  assert.ok(Math.abs(c.home.edge - recomputed) < 1e-6, `edge≠p_adj·odds-1 (${c.home.edge} vs ${recomputed})`);
  assert.ok(c.home.max_odds > c.home.fair_odds, 'best price must beat fair odds when edge fires');
  // Outcomes priced at the anchor should NOT flag value.
  assert.strictEqual(c.draw.has_edge, false);
  assert.strictEqual(c.away.has_edge, false);
});

// ── The market-anchored rules, added 6 Aug 2026 ──────────────────────────────
console.log('\ncomputeConsensus — the anchor');
test('NO Pinnacle price → null, never a fallback to the panel', () => {
  // The fallback is the dangerous case: it would quietly restore consensus
  // pricing on exactly the fixtures with the thinnest sharp coverage.
  assert.strictEqual(computeConsensus([
    row('bet365',      2.10, 3.60, 3.70),
    row('williamhill', 2.35, 3.50, 3.60),
    row('betvictor',   2.20, 3.55, 3.65),
  ]), null);
});
test('an incomplete Pinnacle line is not an anchor', () => {
  // Two legs of a three-way book normalise to 1 and price the third at zero.
  assert.strictEqual(computeConsensus([
    row('bet365',   2.10, 3.60, 3.70),
    row('pinnacle', 2.10, null, 3.70),
  ]), null);
});
test('fair value is the anchor alone — the soft panel cannot move it', () => {
  const anchored = odds => computeConsensus([
    row('pinnacle', 2.10, 3.60, 3.70),
    ...odds,
  ]);
  // Two wildly different soft panels, one identical anchor.
  const a = anchored([row('bet365', 2.10, 3.60, 3.70), row('williamhill', 2.12, 3.62, 3.72)]);
  const b = anchored([row('bet365', 2.40, 3.90, 4.10), row('williamhill', 2.45, 3.95, 4.15)]);
  assert.ok(Math.abs(a.home.p_adj - b.home.p_adj) < 1e-12,
    'fair probability must not depend on the books being measured against it');
});
test('the exchange is never the best price', () => {
  const c = computeConsensus([
    row('bet365',        2.10, 3.60, 3.70),
    row('pinnacle',      2.10, 3.60, 3.70),
    row('betfair_ex_uk', 2.90, 3.50, 3.60),  // pre-commission, on a resting stake
    row('williamhill',   2.20, 3.55, 3.65),
  ]);
  assert.strictEqual(c.home.max_odds, 2.20, 'exchange price must not be taken as available');
});
test('Pinnacle is the anchor and never its own best price', () => {
  // Taking the best price from the book that defines fair value compares a
  // number with itself and hands back the vig as edge.
  const c = computeConsensus([
    row('pinnacle',    2.90, 3.60, 3.70),
    row('bet365',      2.10, 3.60, 3.70),
    row('williamhill', 2.20, 3.55, 3.65),
  ]);
  assert.strictEqual(c.home.max_odds, 2.20);
  assert.ok(c.home.max_odds < 2.90);
});
test('bookmakerCount counts BETTABLE books only', () => {
  const c = computeConsensus([
    row('pinnacle',      2.10, 3.60, 3.70),   // anchor — not counted
    row('betfair_ex_uk', 2.10, 3.60, 3.70),   // exchange — not counted
    row('bet365',        2.10, 3.60, 3.70),
    row('williamhill',   2.20, 3.55, 3.65),
  ]);
  assert.strictEqual(c.bookmakerCount, 2, 'only the two bettable books compete for best');
});
test('efficient market (all books agree) → no edge', () => {
  const c = computeConsensus([
    row('bet365',   2.00, 3.60, 4.00),
    row('pinnacle', 2.00, 3.60, 4.00),
  ]);
  assert.strictEqual(c.home.has_edge, false);
  assert.strictEqual(c.draw.has_edge, false);
  assert.strictEqual(c.away.has_edge, false);
});

// ── computeConsensus: palpable-outlier & implausible-edge guards ──────────────
console.log('\ncomputeConsensus — outlier / implausible guards');
test('palpable outlier price is dropped from best-odds (>=3 books)', () => {
  const c = computeConsensus([
    row('pinnacle',    3.50, 3.40, 2.10),
    row('bet365',      3.50, 3.40, 2.10),
    row('williamhill', 3.45, 3.40, 2.10),
    row('betvictor',   40.0, 3.40, 2.10), // >3× the median → dropped
  ]);
  assert.notStrictEqual(c.home.max_odds, 40.0, 'the 40.0 outlier must not become the best price');
  assert.ok(c.home.max_odds <= 3.50 * 3, 'best price should be within the outlier bound');
});
test('implausible edge (>MAX_PLAUSIBLE_EDGE) is rejected, not published', () => {
  // Two bettable books so the outlier filter (needs >=3 prices) stays out of
  // the way, and one absurd home price.
  const c = computeConsensus([
    row('pinnacle',    2.00, 3.60, 4.00),
    row('bet365',      2.00, 3.60, 4.00),
    row('williamhill', 5.00, 3.60, 4.00),
  ]);
  assert.strictEqual(c.home.has_edge, false, 'implausible edge must be dropped');
  assert.strictEqual(c.home.edge, 0);
});
test('an unknown bookmaker is not a takeable price', () => {
  // Fails closed: a book we have never heard of is not one the reader holds.
  const c = computeConsensus([
    row('pinnacle',    2.10, 3.60, 3.70),
    row('bet365',      2.10, 3.60, 3.70),
    row('brand_new_book', 9.9, 3.60, 3.70),
  ]);
  assert.strictEqual(c.home.max_odds, 2.10);
});

// ── computeMatch: row builder ────────────────────────────────────────────────
console.log('\ncomputeMatch');
test('no priceable odds → { skipped: true }', () => {
  assert.deepStrictEqual(computeMatch({ id: 'm1', odds: [] }), { skipped: true });
});
// Six bettable books, the gate's floor. Below it the "best price" is usually
// one stale line rather than a real outlier, so a thinner fixture is correctly
// rejected and cannot be used to test the value path.
const SIX_BOOKS = (h, d, a) => [
  row('bet365', h, d, a), row('betvictor', h, d, a), row('unibet_uk', h, d, a),
  row('betano', h, d, a), row('10bet', h, d, a), row('marathonbet', h, d, a),
];

test('an incomplete 1X2 market emits NO signal — the three-way guard', () => {
  // A 1X2 vector short a leg is not a market. The three prices are de-vigged
  // TOGETHER, so a missing draw does not merely leave the draw unpriced — it
  // makes the home and away fair lines wrong too, and any edge measured
  // against them is an artefact rather than a disagreement about price.
  //
  // Measured before the guard was written: 0 of 210 rows computed that half
  // hour carried a null leg, so this is a ratchet under lib/devig's refusal
  // and the MIN_BOOKMAKERS floor, not a repair of a live fault.
  for (const [label, h, d, a] of [
    ['no draw',  2.10, null, 3.70],
    ['no away',  2.10, 3.60, null],
    ['no home',  null, 3.60, 3.70],
    ['zero leg', 2.10, 0,    3.70],
    ['leg at 1', 2.10, 1,    3.70],
  ]) {
    const r = computeMatch({ id: 'inc', odds: [row('pinnacle', h, d, a), ...SIX_BOOKS(h, d, a)] });
    assert.strictEqual(r.skipped, true, `${label} must be skipped`);
    assert.strictEqual(r.row, undefined, `${label} must write no row`);
  }
});

test('a COMPLETE three-way market still builds a row — the guard is not a wall', () => {
  const r = computeMatch({ id: 'ok', odds: [row('pinnacle', 2.10, 3.60, 3.70), ...SIX_BOOKS(2.10, 3.60, 3.70)] });
  assert.strictEqual(r.skipped, false, 'a complete vector must survive the guard');
});

test('builds a MARKET_ANCHORED row and flags value on a real edge', () => {
  const match = {
    id: 'm2',
    odds: [
      row('pinnacle', 2.10, 3.60, 3.70),
      ...SIX_BOOKS(2.10, 3.60, 3.70),
      row('williamhill', 2.35, 3.50, 3.60),
    ],
  };
  const r = computeMatch(match);
  assert.strictEqual(r.skipped, false, 'should not be skipped');
  assert.strictEqual(r.hasValue, true, 'a real home edge means the match has value');
  assert.strictEqual(r.row.match_id, 'm2');
  // MARKET_ANCHORED, not MARKET_CONSENSUS: a row priced against the Shin-de-vigged
  // anchor must not inherit the consensus's measured verdict in either direction.
  assert.strictEqual(r.row.model_architecture, 'MARKET_ANCHORED');
  assert.strictEqual(r.row.best_home_odds, 2.35);
  assert.strictEqual(r.row.home_value, true, 'home edge ≥ EV_THRESHOLD should be value');
  assert.ok(r.row.max_edge_score > 0 && r.row.max_edge_score <= 100);
  assert.strictEqual(r.row.best_outcome, 'home');
});
// ── The gate, at the computed_values layer ──────────────────────────────────
//
// Added 6 Aug 2026 after the first live run of the market-anchored path shipped
// a board of longshots. Swapping fair value to the Shin-de-vigged anchor made
// the longshot edges MORE precise, not less frequent, and the gate that removes
// them was sitting in lib/marketAnchor.js with nothing on this path calling it.
console.log('\ncomputeMatch — the gate');

test('a longshot outside the price ceiling is NOT flagged as value', () => {
  // The live Harrogate v Solihull row, reproduced: away best 5.75 against a
  // 21.1% fair probability — a +21.5% edge that is outside the gate on BOTH
  // the 4.50 price ceiling and the 30% probability floor.
  const match = {
    id: 'm-longshot',
    odds: [
      row('pinnacle', 1.62, 4.10, 4.90),
      ...SIX_BOOKS(1.62, 4.10, 4.90),
      row('williamhill', 1.62, 4.10, 5.75),   // the fat away price, at a 7th book
    ],
  };
  const r = computeMatch(match);
  // The edge is REAL — that is what makes the test worth having. The gate is
  // not rejecting noise, it is rejecting a genuine positive-EV longshot,
  // because that is the bet the settled record says loses.
  assert.ok(r.consensus.away.edge > 0.03,
    `the edge should be real and positive, got ${r.consensus.away.edge}`);
  assert.ok(r.consensus.away.max_odds > 4.50, 'and outside the price ceiling');
  assert.strictEqual(r.row.away_value, false, 'a 5.75 longshot must not be value');
  assert.strictEqual(r.row.best_outcome, null, 'and must not become the headline pick');
  assert.strictEqual(r.hasValue, false);
});

test('an outcome under the fair-probability floor is NOT flagged', () => {
  // Inside the price ceiling (4.20 < 4.50) but a 24% fair shot — the floor is
  // what catches this one, which is why both checks exist.
  const match = {
    id: 'm-floor',
    odds: [
      row('pinnacle', 1.90, 3.70, 4.40),
      ...SIX_BOOKS(1.90, 3.70, 4.40),
      row('williamhill', 1.90, 3.70, 4.45),
    ],
  };
  const r = computeMatch(match);
  const fairProb = r.consensus.away.p_adj;
  assert.ok(fairProb < 0.30, `fixture should sit under the floor, got ${fairProb}`);
  assert.strictEqual(r.row.away_value, false);
});

test('too few bettable books blocks value however good the price', () => {
  const match = {
    id: 'm-thin',
    odds: [row('pinnacle', 2.10, 3.60, 3.70), row('bet365', 2.60, 3.60, 3.70)],
  };
  const r = computeMatch(match);
  assert.strictEqual(r.hasValue, false, 'two books is under the six-book floor');
});

test('efficient market → row with no value flags', () => {
  const r = computeMatch({
    id: 'm3',
    odds: [ row('bet365', 2.00, 3.60, 4.00), row('pinnacle', 2.00, 3.60, 4.00) ],
  });
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(r.hasValue, false);
  assert.strictEqual(r.row.home_value, false);
  assert.strictEqual(r.row.draw_value, false);
  assert.strictEqual(r.row.away_value, false);
  assert.strictEqual(r.row.best_outcome, null, 'no edge → no best_outcome');
});

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
