'use strict';

/**
 * engine.independentlines.test.js — the scoring anchor that did not pick the bet.
 *
 * The property under test is INDEPENDENCE, not arithmetic: this benchmark exists
 * because scoring MARKET_ANCHORED against Pinnacle's close measured the
 * selection rule against itself. Every test here is about what the vector is
 * built FROM.
 */

const assert = require('assert');
const {
  independentVector, linesForMatch, INDEPENDENT_BOOKS, MIN_BOOKS, MARKETS,
} = require('./captureIndependentLines');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

const H2H = MARKETS.h2h;
const KICKOFF = '2026-08-19T15:00:00.000Z';
const T = m => new Date(new Date(KICKOFF).getTime() - m * 60000).toISOString();

/** n bettable books all quoting the same complete h2h vector. */
const panel = (n, prices = [2.5, 3.4, 2.9], at = T(60)) =>
  INDEPENDENT_BOOKS.slice(0, n).map(b => ({
    bookmaker: b, market: 'h2h', market_line: null,
    home_odds: prices[0], draw_odds: prices[1], away_odds: prices[2], fetched_at: at,
  }));

console.log('\nindependent closing lines');

test('pinnacle is never in the panel this benchmark is built from', () => {
  assert.ok(!INDEPENDENT_BOOKS.includes('pinnacle'));
});

test('a pinnacle quote is ignored even when it is present in the rows', () => {
  const rows = [
    ...panel(MIN_BOOKS, [2.0, 3.4, 4.0]),
    { bookmaker: 'pinnacle', market: 'h2h', market_line: null,
      home_odds: 99, draw_odds: 99, away_odds: 99, fetched_at: T(1) },
  ];
  const v = independentVector(rows, H2H);
  assert.strictEqual(v.bookCount, MIN_BOOKS, 'pinnacle must not raise the book count');
  assert.ok(!v.books.includes('pinnacle'));
  assert.strictEqual(v.prices[0], 2.0, 'a 99.0 pinnacle leg must not move the median');
});

test('fewer than MIN_BOOKS is silence, not a thin consensus', () => {
  assert.strictEqual(independentVector(panel(MIN_BOOKS - 1), H2H), null);
  assert.ok(independentVector(panel(MIN_BOOKS), H2H) !== null);
});

test('the median is taken, not the best price', () => {
  const rows = panel(5).map((r, i) => ({ ...r, home_odds: [2.0, 2.1, 2.2, 2.3, 9.0][i] }));
  const v = independentVector(rows, H2H);
  assert.strictEqual(v.prices[0], 2.2, 'a single long outlier must not become the benchmark');
});

test('an even panel takes the midpoint of the two middle prices', () => {
  const rows = panel(6).map((r, i) => ({ ...r, home_odds: [2.0, 2.1, 2.2, 2.4, 2.5, 2.6][i] }));
  assert.strictEqual(independentVector(rows, H2H).prices[0], 2.3);
});

test('only the latest quote per book counts', () => {
  const rows = [
    ...panel(MIN_BOOKS, [2.0, 3.4, 4.0], T(300)),
    { bookmaker: INDEPENDENT_BOOKS[0], market: 'h2h', market_line: null,
      home_odds: 5.0, draw_odds: 3.4, away_odds: 4.0, fetched_at: T(10) },
  ];
  const v = independentVector(rows, H2H);
  assert.strictEqual(v.bookCount, MIN_BOOKS, 'a second quote from one book is not a second book');
  assert.strictEqual(v.quotedAt, T(10));
});

test('a book missing a leg contributes to no leg at all', () => {
  const rows = panel(MIN_BOOKS + 1);
  rows[0].draw_odds = null;
  const v = independentVector(rows, H2H);
  assert.strictEqual(v.bookCount, MIN_BOOKS);
  assert.ok(!v.books.includes(rows[0].bookmaker));
});

test('a post-kickoff quote never reaches the vector', () => {
  const match = { id: 'm1', kickoff_at: KICKOFF };
  const after = panel(MIN_BOOKS + 3, [2.5, 3.4, 2.9],
    new Date(new Date(KICKOFF).getTime() + 60000).toISOString());
  assert.deepStrictEqual(linesForMatch(match, after), []);
});

test('a stale vector is no closing line', () => {
  const match = { id: 'm1', kickoff_at: KICKOFF };
  assert.deepStrictEqual(linesForMatch(match, panel(MIN_BOOKS, [2.5, 3.4, 2.9], T(13 * 60))), []);
  assert.ok(linesForMatch(match, panel(MIN_BOOKS, [2.5, 3.4, 2.9], T(11 * 60))).length > 0);
});

test('an arbitrage vector is refused rather than de-vigged', () => {
  const match = { id: 'm1', kickoff_at: KICKOFF };
  assert.deepStrictEqual(linesForMatch(match, panel(MIN_BOOKS, [4.0, 4.0, 4.0])), []);
});

test('a complete fixture yields one row per selection, probabilities summing to 1', () => {
  const match = { id: 'm1', kickoff_at: KICKOFF };
  const out = linesForMatch(match, panel(MIN_BOOKS + 2, [2.5, 3.4, 2.9]));
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map(r => r.selection), ['home', 'draw', 'away']);
  const s = out.reduce((a, r) => a + r.no_vig_prob, 0);
  assert.ok(Math.abs(s - 1) < 1e-5, `probs sum ${s}`);
  assert.ok(out.every(r => r.no_vig_odds > r.closing_odds),
    'removing margin must lengthen every fair price relative to the quoted one');
  assert.ok(out.every(r => new Date(r.quoted_at) <= new Date(r.kickoff_at)));
  assert.ok(out.every(r => !r.books.includes('pinnacle')));
});

test('totals and btts map over/yes to home_odds and under/no to away_odds', () => {
  // A two-way vector: [2.5, 2.9] sums to an overround of 0.74 and would be
  // refused as arbitrage, which is the right call and the wrong fixture.
  const mk = (market, line) => panel(MIN_BOOKS, [1.90, null, 1.90])
    .map(r => ({ ...r, market, market_line: line }));
  const match = { id: 'm1', kickoff_at: KICKOFF };
  const t = linesForMatch(match, mk('totals', 2.5));
  assert.deepStrictEqual(t.map(r => r.selection), ['over', 'under']);
  assert.strictEqual(t[0].market_line, 2.5);
  const b = linesForMatch(match, mk('btts', null));
  assert.deepStrictEqual(b.map(r => r.selection), ['btts_yes', 'btts_no']);
  assert.strictEqual(b[0].market_line, null);
});

console.log(`\nindependent lines: ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
