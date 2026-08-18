'use strict';

/**
 * engine.closinglines.test.js — THE CLOSING LINE IS THE BENCHMARK, SO IT HAS TO
 * BE THE CLOSE.
 *
 * CLV is the only feedback available inside a week, and `paper_trade_gate()`
 * opens the publication gate on it. Before this, two things called themselves
 * the closing line and neither was one:
 *
 *   `odds_snapshots.snapshot_type = 'closing'` labels anything from 60 minutes
 *   BEFORE kickoff to 180 minutes AFTER. 22,988 of 32,303 such rows were
 *   captured after kickoff; the median was 42 minutes into the match.
 *
 *   `settle_match_signals()` de-vigged PROPORTIONALLY, over whichever single
 *   bookmaker row was fetched last, with no book filter at all.
 *
 * These pin what a closing line is now: strictly pre-kickoff, anchor-preferred,
 * Shin-de-vigged, and refused outright when it cannot be built honestly.
 */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
function close(a, b, tol, m) { assert(Math.abs(a - b) <= tol, `${m} — got ${a}, expected ${b} ±${tol}`); }

const { linesForMatch, closingVector, MARKETS } = require('./captureClosingLines');

const KO = '2026-08-18T14:00:00Z';
const MATCH = { id: 'm1', kickoff_at: KO };
const H = (o) => ({ market: 'h2h', market_line: null, ...o });

console.log('\nwhat counts as the close');

test('a price quoted AFTER kickoff is never the close', () => {
  const rows = [
    H({ bookmaker: 'pinnacle', home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-18T13:45:00Z' }),
    // 40 minutes in, a goal has gone in. The old 'closing' label accepted this.
    H({ bookmaker: 'pinnacle', home_odds: 1.30, draw_odds: 5.50, away_odds: 12.0, fetched_at: '2026-08-18T14:40:00Z' }),
  ];
  const lines = linesForMatch(MATCH, rows);
  const home = lines.find(l => l.selection === 'home');
  close(home.closing_odds, 2.10, 1e-9, 'must freeze the pre-kickoff price');
  assert(new Date(home.quoted_at) <= new Date(KO), 'quoted_at must be at or before kickoff');
});

test('the anchor is preferred over the panel', () => {
  const rows = [
    H({ bookmaker: 'pinnacle',  home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-18T13:50:00Z' }),
    H({ bookmaker: 'bet365',    home_odds: 2.20, draw_odds: 3.30, away_odds: 3.50, fetched_at: '2026-08-18T13:55:00Z' }),
    H({ bookmaker: 'williamhill', home_odds: 2.15, draw_odds: 3.35, away_odds: 3.55, fetched_at: '2026-08-18T13:55:00Z' }),
  ];
  const lines = linesForMatch(MATCH, rows);
  assert(lines.every(l => l.basis === 'anchor'), 'Pinnacle must supply the close when it quoted');
  close(lines.find(l => l.selection === 'home').closing_odds, 2.10, 1e-9, 'anchor price');
  assert(lines[0].book_count === 1, 'the anchor is one book, and says so');
});

test('without the anchor it falls back to the panel median, and says so', () => {
  const rows = [
    H({ bookmaker: 'bet365',      home_odds: 2.20, draw_odds: 3.30, away_odds: 3.50, fetched_at: '2026-08-18T13:55:00Z' }),
    H({ bookmaker: 'williamhill', home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-18T13:55:00Z' }),
    H({ bookmaker: 'betvictor',   home_odds: 2.15, draw_odds: 3.35, away_odds: 3.55, fetched_at: '2026-08-18T13:55:00Z' }),
  ];
  const lines = linesForMatch(MATCH, rows);
  assert(lines.every(l => l.basis === 'consensus'), 'basis must be recorded, never assumed');
  close(lines.find(l => l.selection === 'home').closing_odds, 2.15, 1e-9, 'median of 2.10/2.15/2.20');
  assert(lines[0].book_count === 3, 'the panel size is recorded');
});

test('a lone non-anchor book is not a consensus', () => {
  const rows = [
    H({ bookmaker: 'bet365', home_odds: 2.20, draw_odds: 3.30, away_odds: 3.50, fetched_at: '2026-08-18T13:55:00Z' }),
  ];
  assert(linesForMatch(MATCH, rows).length === 0, 'one book is not a market');
});

test('only the LATEST pre-kickoff quote per book is used', () => {
  const rows = [
    H({ bookmaker: 'pinnacle', home_odds: 2.50, draw_odds: 3.40, away_odds: 3.10, fetched_at: '2026-08-18T08:00:00Z' }),
    H({ bookmaker: 'pinnacle', home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-18T13:50:00Z' }),
  ];
  const home = linesForMatch(MATCH, rows).find(l => l.selection === 'home');
  close(home.closing_odds, 2.10, 1e-9, 'the close is the last quote, not the best one');
});

test('a stale line is not a close', () => {
  const rows = [
    // Quoted three days out and never updated. Freezing it would report drift
    // that never happened.
    H({ bookmaker: 'pinnacle', home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-15T09:00:00Z' }),
  ];
  assert(linesForMatch(MATCH, rows).length === 0, 'a 3-day-old quote must not be frozen as the close');
});

console.log('\nthe de-vig');

test('no_vig_odds is longer than the closing price, on every leg', () => {
  const rows = [
    H({ bookmaker: 'pinnacle', home_odds: 2.10, draw_odds: 3.40, away_odds: 3.60, fetched_at: '2026-08-18T13:50:00Z' }),
  ];
  const lines = linesForMatch(MATCH, rows);
  assert(lines.length === 3, 'three selections');
  for (const l of lines) {
    assert(l.no_vig_odds > l.closing_odds,
      `${l.selection}: fair ${l.no_vig_odds} must exceed the priced ${l.closing_odds} once margin is out`);
  }
  const sum = lines.reduce((s, l) => s + l.no_vig_prob, 0);
  close(sum, 1, 1e-4, 'de-vigged probabilities must sum to 1');
  assert(lines[0].overround > 1, 'the overround is recorded and is real');
});

test('a vector with no margin left is refused', () => {
  const rows = [
    H({ bookmaker: 'pinnacle', home_odds: 2.70, draw_odds: 3.70, away_odds: 3.70, fetched_at: '2026-08-18T13:50:00Z' }),
  ];
  assert(linesForMatch(MATCH, rows).length === 0,
    'a sub-1 overround is not a market and cannot be a benchmark');
});

console.log('\ntwo-way markets carry their line');

test('totals lines are kept apart by handicap', () => {
  const rows = [
    { market: 'totals', market_line: 2.5, bookmaker: 'pinnacle', home_odds: 1.95, away_odds: 1.95, fetched_at: '2026-08-18T13:50:00Z' },
    { market: 'totals', market_line: 3.5, bookmaker: 'pinnacle', home_odds: 3.40, away_odds: 1.35, fetched_at: '2026-08-18T13:50:00Z' },
  ];
  const lines = linesForMatch(MATCH, rows);
  const l25 = lines.filter(l => Number(l.market_line) === 2.5);
  const l35 = lines.filter(l => Number(l.market_line) === 3.5);
  assert(l25.length === 2 && l35.length === 2, 'both handicaps priced, separately');
  close(l25.find(l => l.selection === 'over').closing_odds, 1.95, 1e-9, 'over 2.5');
  close(l35.find(l => l.selection === 'over').closing_odds, 3.40, 1e-9, 'over 3.5');
});

test('BTTS maps to yes/no, not over/under', () => {
  const rows = [
    { market: 'btts', market_line: null, bookmaker: 'pinnacle', home_odds: 1.80, away_odds: 2.05, fetched_at: '2026-08-18T13:50:00Z' },
  ];
  const sels = linesForMatch(MATCH, rows).map(l => l.selection).sort();
  assert(JSON.stringify(sels) === JSON.stringify(['btts_no', 'btts_yes']), `got ${sels}`);
});

console.log(`\n${failed === 0 ? '✓' : '✗'} closing lines: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
