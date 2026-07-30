/**
 * engine.inplayseries.test.js — in-play market series builder tests.
 * Run: node engine.inplayseries.test.js
 */
'use strict';
const assert = require('assert');
const { buildRows, median, best } = require('./captureInplaySeries');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

const MATCH = { id: 'aaaaaaaa-0000-0000-0000-000000000001', minute: 60,
                goals_home: 1, goals_away: 0 };
const BASE = { lambda_home: 1.6, lambda_away: 1.1 };
const ODDS = [
  { market: 'h2h', bookmaker: 'bet365',  home_odds: 1.40, draw_odds: 4.5, away_odds: 9.0 },
  { market: 'h2h', bookmaker: 'skybet',  home_odds: 1.45, draw_odds: 4.2, away_odds: 8.5 },
  { market: 'h2h', bookmaker: 'pinnacle',home_odds: 1.42, draw_odds: 4.4, away_odds: 9.4 },
  { market: 'totals', market_line: 2.5, bookmaker: 'bet365', home_odds: 2.10, away_odds: 1.75 },
  { market: 'totals', market_line: 3.5, bookmaker: 'bet365', home_odds: 4.00, away_odds: 1.25 },
];

test('median / best helpers', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([]), null);
  assert.strictEqual(best([{ v: 1.4 }, { v: 1.45 }, { v: 1.42 }]).v, 1.45);
});

test('builds one row per priced selection (h2h + the 2.5 line only)', () => {
  const rows = buildRows(MATCH, ODDS, BASE);
  const sels = rows.map(r => r.selection).sort();
  assert.deepStrictEqual(sels, ['away', 'draw', 'home', 'over', 'under']);
  // the 3.5 totals line must NOT produce rows
  assert.ok(rows.every(r => r.market_line === null || Number(r.market_line) === 2.5));
});

test('market shape: consensus is median, best is highest, book_count correct', () => {
  const home = buildRows(MATCH, ODDS, BASE).find(r => r.selection === 'home');
  assert.strictEqual(home.consensus_odds, 1.42);
  assert.strictEqual(home.best_odds, 1.45);
  assert.strictEqual(home.best_bookmaker, 'skybet');
  assert.strictEqual(home.book_count, 3);
});

test('model line present and coherent with the live state', () => {
  const rows = buildRows(MATCH, ODDS, BASE);
  const p = {};
  for (const r of rows) p[r.selection] = r.model_prob;
  const sum = p.home + p.draw + p.away;
  assert.ok(Math.abs(sum - 1) < 0.02, `1X2 model probs ~sum to 1 (got ${sum})`);
  assert.ok(Math.abs((p.over + p.under) - 1) < 1e-6, 'over+under = 1');
  // 1-0 up at 60' → home strongly favoured
  assert.ok(p.home > 0.7, `home should be favoured (${p.home})`);
});

test('edge = model_prob * best_odds - 1', () => {
  // edge is computed from the FULL-precision probability; model_prob is stored
  // rounded to 4dp. Recomputing from the rounded value therefore differs by up
  // to 0.5e-4 x odds, so the tolerance must scale with the price.
  for (const r of buildRows(MATCH, ODDS, BASE)) {
    if (r.model_prob == null) continue;
    const tol = 1e-4 * Math.max(1, r.best_odds);
    assert.ok(Math.abs(r.edge - (r.model_prob * r.best_odds - 1)) <= tol,
      `${r.selection}: edge ${r.edge} vs ${r.model_prob * r.best_odds - 1}`);
  }
});

test('match state is stamped on every point', () => {
  for (const r of buildRows(MATCH, ODDS, BASE)) {
    assert.strictEqual(r.minute, 60);
    assert.strictEqual(r.goals_home, 1);
    assert.strictEqual(r.goals_away, 0);
    assert.ok(r.captured_at);
  }
});

test('no baseline → market side still recorded, model side null', () => {
  const rows = buildRows(MATCH, ODDS, null);
  assert.ok(rows.length > 0, 'still records market movement');
  assert.ok(rows.every(r => r.model_prob === null && r.edge === null));
  assert.ok(rows.every(r => r.best_odds > 1), 'market data intact');
});

test('model reprices as the game changes (late 1-0 → higher home prob)', () => {
  const early = buildRows({ ...MATCH, minute: 10 }, ODDS, BASE).find(r => r.selection === 'home');
  const late  = buildRows({ ...MATCH, minute: 88 }, ODDS, BASE).find(r => r.selection === 'home');
  assert.ok(late.model_prob > early.model_prob,
    `same 1-0 lead is worth more at 88' (${early.model_prob} → ${late.model_prob})`);
});

console.log(`\nin-play series tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
