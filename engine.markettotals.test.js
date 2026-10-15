'use strict';

/**
 * engine.markettotals.test.js — MARKET_ANCHORED_TOTALS (migration 150).
 * Zero deps, no DB / network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateFixture, isHalfGoalLine, ARCHITECTURE, THRESHOLDS } = require('./lib/marketAnchorTotals');
const { shinDevig } = require('./lib/devig');
const { isPublished } = require('./lib/publication');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

const NOW = Date.parse('2026-10-15T12:00:00Z');
const fresh = '2026-10-15T11:50:00Z';
const q = (bookmaker, line, over, under, confirmed_at = fresh) =>
  ({ bookmaker, market: 'totals', market_line: line, home_odds: over, away_odds: under, confirmed_at });

// Pinnacle 2.5 at 1.90 / 1.95; three takeable books, one generous on the over.
const base = () => [
  q('pinnacle', 2.5, 1.90, 1.95),
  q('bet365', 2.5, 2.05, 1.80),
  q('betano', 2.5, 1.88, 1.85),
  q('betvictor', 2.5, 1.87, 1.86),
];

console.log('\nMARKET_ANCHORED_TOTALS');

test('it is unpublished, and named so it cannot inherit MARKET_ANCHORED', () => {
  assert.strictEqual(ARCHITECTURE, 'MARKET_ANCHORED_TOTALS');
  assert.strictEqual(isPublished(ARCHITECTURE), false);
  assert.strictEqual(isPublished('MARKET_ANCHORED'), true, 'h2h unchanged');
});

test('a generous over at the same line is a hit, edge against Shin-de-vigged Pinnacle', () => {
  const hits = evaluateFixture(base(), { now: NOW });
  assert.strictEqual(hits.length, 1);
  const h = hits[0];
  const p = shinDevig([1.90, 1.95]).probs[0];
  assert.strictEqual(h.selection, 'over');
  assert.strictEqual(h.market_line, 2.5);
  assert.strictEqual(h.book, 'bet365');
  assert.ok(Math.abs(h.edge - (p * 2.05 - 1)) < 1e-6);
  assert.strictEqual(h.books_quoting, 3);
});

test('every hit carries a full score', () => {
  const [h] = evaluateFixture(base(), { now: NOW });
  for (const k of ['model_prob', 'market_prob', 'prob_gap', 'model_sigma', 'mxs', 'mxs_band']) {
    assert.ok(h[k] != null, `${k} populated`);
  }
  assert.strictEqual(h.model_sigma, 0.03);
});

test('a price below fair is not a hit', () => {
  const rows = base(); rows[1] = q('bet365', 2.5, 1.85, 1.80);
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('never compares across lines, never interpolates', () => {
  // Pinnacle only at 2.5; the generous price is at 3.5.
  const rows = [q('pinnacle', 2.5, 1.90, 1.95),
    q('bet365', 3.5, 3.40, 1.30), q('betano', 3.5, 3.10, 1.32), q('betvictor', 3.5, 3.10, 1.32)];
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('half-goal lines only — whole and quarter lines push', () => {
  assert.ok(isHalfGoalLine(2.5) && isHalfGoalLine(0.5) && isHalfGoalLine('3.5'));
  for (const l of [2, 2.25, 2.75, 3, 0, null, 'x']) assert.ok(!isHalfGoalLine(l), String(l));
  const rows = base().map(r => ({ ...r, market_line: 2.75 }));
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('fewer than three takeable books is not a hit', () => {
  const rows = base().slice(0, 3);
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('non-UK and excluded books neither set the price nor count', () => {
  const rows = [q('pinnacle', 2.5, 1.90, 1.95), q('bet365', 2.5, 1.80, 1.80),
    q('marathonbet', 2.5, 2.30, 1.70), q('1xbet', 2.5, 2.30, 1.70), q('sbo', 2.5, 2.30, 1.70)];
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('a stale Pinnacle quote anchors nothing', () => {
  const rows = base(); rows[0] = q('pinnacle', 2.5, 1.90, 1.95, '2026-10-15T10:30:00Z');
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('a stale soft quote does not count toward the three', () => {
  const rows = base(); rows[3] = q('betvictor', 2.5, 1.87, 1.86, '2026-10-15T10:00:00Z');
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('price at or above 5.0 is not a hit', () => {
  const rows = [q('pinnacle', 4.5, 5.20, 1.17), q('bet365', 4.5, 5.50, 1.14),
    q('betano', 4.5, 5.0, 1.15), q('betvictor', 4.5, 4.9, 1.15)];
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
  assert.strictEqual(THRESHOLDS.MAX_PRICE, 5.0);
});

test('no under price anywhere means no market side, so no row', () => {
  const rows = base().map(r => r.bookmaker === 'pinnacle' ? r : { ...r, away_odds: null });
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('h2h rows are ignored', () => {
  const rows = base().map(r => ({ ...r, market: 'h2h' }));
  assert.strictEqual(evaluateFixture(rows, { now: NOW }).length, 0);
});

test('the runner writes paper_trades and never value_signals or computed_values', () => {
  const src = fs.readFileSync(path.join(__dirname, 'paperTradeTotals.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/from\(\s*'value_signals'/.test(src), 'no value_signals write');
  assert.ok(!/from\(\s*'computed_values'/.test(src), 'no computed_values write');
  assert.ok(/insert_paper_trade/.test(src) && /settle_paper_trade/.test(src));
  assert.ok(!/p_scoring_anchor|pinnacle_anchor/.test(src),
    'scoring anchor stays independent_consensus — pinnacle_anchor would HOLD the gate for ever');
});

test('migration 150 keeps the model out of value_signals and unpublished', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '150_market_anchored_totals_paper_trade.sql'), 'utf8')
    .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  assert.ok(!/value_signals_model_architecture_check\s+check/i.test(sql), 'does not re-add the CHECK');
  assert.ok(/'MARKET_ANCHORED_TOTALS',\s*0\.03,\s*'floor',\s*1,\s*0,\s*false/.test(sql), 'publish false');
  const updates = [...sql.matchAll(/do update\s+set([^;]*);/gi)].map(m => m[1]);
  assert.ok(updates.length >= 2, 'found the upserts');
  assert.ok(updates.every(u => !/\bpublish\s*=/i.test(u)), 'publish is never in an update list');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
