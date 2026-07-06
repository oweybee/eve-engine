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
    row('bet365',        2.10, 3.60, 3.70),
    row('pinnacle',      2.10, 3.60, 3.70),
    row('betfair_ex_uk', 2.35, 3.50, 3.60), // best home price
  ]);
  assert.strictEqual(c.home.has_edge, true, 'home should have edge');
  assert.strictEqual(c.home.max_odds, 2.35, 'best home odds should be 2.35');
  assert.ok(c.home.edge > 0 && c.home.edge < 0.30, `edge out of range: ${c.home.edge}`);
  // Internal consistency: edge == p_adj * best_odds - 1 (cross-checks two fields)
  const recomputed = c.home.p_adj * c.home.max_odds - 1;
  assert.ok(Math.abs(c.home.edge - recomputed) < 1e-6, `edge≠p_adj·odds-1 (${c.home.edge} vs ${recomputed})`);
  assert.ok(c.home.max_odds > c.home.fair_odds, 'best price must beat fair odds when edge fires');
  // Outcomes at the consensus price should NOT flag value.
  assert.strictEqual(c.draw.has_edge, false);
  assert.strictEqual(c.away.has_edge, false);
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
    row('bet365',    3.50, 3.40, 2.10),
    row('pinnacle',  3.50, 3.40, 2.10),
    row('rogue_book', 40.0, 3.40, 2.10), // 40.0 is >3× the 3.50 median → dropped
  ]);
  assert.notStrictEqual(c.home.max_odds, 40.0, 'the 40.0 outlier must not become the best price');
  assert.ok(c.home.max_odds <= 3.50 * 3, 'best price should be within the outlier bound');
});
test('implausible edge (>MAX_PLAUSIBLE_EDGE) is rejected, not published', () => {
  // 2 books (outlier filter needs >=3), one absurd home price at 5.0.
  const c = computeConsensus([
    row('bet365', 2.00, 3.60, 4.00),
    row('rogue',  5.00, 3.60, 4.00),
  ]);
  assert.strictEqual(c.home.has_edge, false, 'implausible edge must be dropped');
  assert.strictEqual(c.home.edge, 0);
});

// ── computeMatch: row builder ────────────────────────────────────────────────
console.log('\ncomputeMatch');
test('no priceable odds → { skipped: true }', () => {
  assert.deepStrictEqual(computeMatch({ id: 'm1', odds: [] }), { skipped: true });
});
test('builds a MARKET_CONSENSUS row and flags value on a real edge', () => {
  const match = {
    id: 'm2',
    odds: [
      row('bet365',        2.10, 3.60, 3.70),
      row('pinnacle',      2.10, 3.60, 3.70),
      row('betfair_ex_uk', 2.35, 3.50, 3.60),
    ],
  };
  const r = computeMatch(match);
  assert.strictEqual(r.skipped, false, 'should not be skipped');
  assert.strictEqual(r.hasValue, true, 'a real home edge means the match has value');
  assert.strictEqual(r.row.match_id, 'm2');
  assert.strictEqual(r.row.model_architecture, 'MARKET_CONSENSUS');
  assert.strictEqual(r.row.best_home_odds, 2.35);
  assert.strictEqual(r.row.home_value, true, 'home edge ≥ EV_THRESHOLD should be value');
  assert.ok(r.row.max_edge_score > 0 && r.row.max_edge_score <= 100);
  assert.strictEqual(r.row.best_outcome, 'home');
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
