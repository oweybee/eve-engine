'use strict';

/**
 * engine.marketprob.test.js — THE PRICE/CONSENSUS SCALE INVARIANT.
 *
 * One number decides whether any EV- or Kelly-based score on this platform
 * means anything:
 *
 *     market_prob × detected_odds
 *
 * `market_prob` is the de-vigged probability of the SAME side, at the SAME
 * line, out of the SAME vector the price was taken from. So the product is
 * exactly `1 / overround` of the market the reader can bet into — a real book
 * keeps margin, so it must land BELOW 1, and across a panel of best prices it
 * settles around 0.94–0.99.
 *
 * ABOVE 1 IS NOT A ROUNDING PROBLEM. It says the de-vigged "fair" line thinks
 * the outcome is likelier than the price you can take — on EVERY leg at once,
 * which means both the over and the under clear the EV threshold and the board
 * publishes two contradictory bets on one market. On 18 Aug 2026 the live
 * ledger had exactly that: 60 totals fixtures and 13 BTTS fixtures with both
 * sides flagged, and a mean product of 1.0167 on totals.
 *
 * The cause was that `bestTwoWay` built the vector out of 24 hours of price
 * history from every book on the feed, in-play feeds included, taking the max
 * of each side independently. These tests pin the three guards that stop it.
 */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function close(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} — got ${a}, expected ${b} ±${tol}`);
}

const sm = require('./lib/secondaryMarkets');
const { shinDevig } = require('./lib/devig');
const ma = require('./lib/marketAnchor');

const T = (o) => ({ market: 'totals', market_line: 2.5, ...o });

console.log('\nthe scale invariant — market_prob × detected_odds');

test('a coherent single-slice panel lands the product below 1', () => {
  const rows = [
    T({ bookmaker: 'bet365',   home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'williamhill', home_odds: 1.97, away_odds: 1.88, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betvictor',   home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  assert(best, 'expected a priced line');
  const d = shinDevig([best.over.odds, best.under.odds]);
  const pOver = d.probs[0] * best.over.odds;
  const pUnder = d.probs[1] * best.under.odds;
  assert(pOver < 1, `over product must be below 1, got ${pOver}`);
  assert(pUnder < 1, `under product must be below 1, got ${pUnder}`);
  assert(pOver > 0.94 && pOver < 0.99, `over product out of band: ${pOver}`);
});

test('THE BUG: best-of-each-side across 24h of history is refused', () => {
  // The same book, two moments. The over drifted out in the morning, the under
  // drifted out in the evening. Pairing them is a market that never existed:
  // 1/2.10 + 1/2.05 = 0.964.
  const rows = [
    T({ bookmaker: 'bet365', home_odds: 2.10, away_odds: 1.75, fetched_at: '2026-08-18T06:00:00Z' }),
    T({ bookmaker: 'bet365', home_odds: 1.78, away_odds: 2.05, fetched_at: '2026-08-18T18:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  // Only the LATEST quote per book survives, so the vector is 1.78 / 2.05.
  assert(best, 'expected the latest quote to still price the line');
  close(best.over.odds, 1.78, 1e-9, 'over must be the latest quote, not the 24h max');
  close(best.under.odds, 2.05, 1e-9, 'under must be the latest quote');
  const d = shinDevig([best.over.odds, best.under.odds]);
  assert(d.probs[0] * best.over.odds < 1, 'product must stay below 1');
});

test('an in-play feed never enters a pre-match vector', () => {
  const rows = [
    T({ bookmaker: 'bet365',    home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betvictor', home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' }),
    // 4.50 on the over because two goals already went in. It is not a
    // pre-match price and pairing it with a pre-match under is an arb.
    T({ bookmaker: 'apifootball_live', home_odds: 4.50, away_odds: 1.20, fetched_at: '2026-08-18T15:30:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  assert(best.over.odds <= 1.95, `in-play price leaked in: ${best.over.odds}`);
  assert(best.over.book !== 'apifootball_live', 'in-play book must not be the best price');
});

test('a sub-1 vector is refused outright rather than de-vigged', () => {
  // Two real bettable books whose best-of-each-side crosses: 1/2.10 + 1/2.05.
  const rows = [
    T({ bookmaker: 'bet365',    home_odds: 2.10, away_odds: 1.70, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betvictor', home_odds: 1.72, away_odds: 2.05, fetched_at: '2026-08-18T10:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  assert(best === null, 'a line with no margin left must not be priced at all');
});

test('the most LIQUID line is chosen, not the thinnest overround', () => {
  const rows = [
    // 2.5: five books, healthy 1.045 overround.
    T({ market_line: 2.5, bookmaker: 'bet365',     home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ market_line: 2.5, bookmaker: 'williamhill',home_odds: 1.94, away_odds: 1.91, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ market_line: 2.5, bookmaker: 'betvictor',  home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ market_line: 2.5, bookmaker: 'unibet_uk',  home_odds: 1.96, away_odds: 1.89, fetched_at: '2026-08-18T10:00:00Z' }),
    // 3.5: one book, tighter overround. The old ranking took this.
    T({ market_line: 3.5, bookmaker: '10bet',      home_odds: 3.40, away_odds: 1.41, fetched_at: '2026-08-18T10:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  close(best.line, 2.5, 1e-9, 'must price the line the most books quote');
});

test('a palpable outlier is dropped before the best price is taken', () => {
  const rows = [
    T({ bookmaker: 'bet365',      home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'williamhill', home_odds: 1.94, away_odds: 1.91, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betvictor',   home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betano',      home_odds: 9.80, away_odds: 1.89, fetched_at: '2026-08-18T10:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  assert(best.over.odds <= 1.95, `outlier survived as best price: ${best.over.odds}`);
});

console.log('\nthe same gate on the h2h vector');

test('devigProbs refuses a three-way vector with no margin', () => {
  // 1/2.70 + 1/3.70 + 1/3.70 = 0.911 — best-of-each across books, crossed.
  const r = ma.devigProbs({ home: 2.70, draw: 3.70, away: 3.70 }, ['home', 'draw', 'away']);
  assert(r.fair === null, 'a sub-1 h2h vector must not produce a market_prob');
  assert(r.arbitrage === true, 'and must say why');
  assert(/overround/.test(r.reason ?? ''), 'the reason must name the overround');
});

test('devigProbs still prices a normal three-way vector, below 1', () => {
  const r = ma.devigProbs({ home: 2.10, draw: 3.40, away: 3.60 }, ['home', 'draw', 'away']);
  assert(r.fair, 'a margin-carrying vector must still de-vig');
  for (const k of ['home', 'draw', 'away']) {
    const product = r.fair[k] * ({ home: 2.10, draw: 3.40, away: 3.60 })[k];
    assert(product < 1, `${k} product must be below 1, got ${product}`);
  }
});

console.log('\nend to end: no market can report value on both sides');

test('the over and the under cannot both be flagged', () => {
  const rows = [
    T({ bookmaker: 'bet365',      home_odds: 1.95, away_odds: 1.90, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'williamhill', home_odds: 1.94, away_odds: 1.91, fetched_at: '2026-08-18T10:00:00Z' }),
    T({ bookmaker: 'betvictor',   home_odds: 1.93, away_odds: 1.92, fetched_at: '2026-08-18T10:00:00Z' }),
  ];
  const best = sm.bestTwoWay(rows, 'totals');
  const d = shinDevig([best.over.odds, best.under.odds]);
  // Whatever the model says, the MARKET side of the two legs sums to 1, so at
  // most one of them can sit under its own best price.
  const both = (d.probs[0] * best.over.odds > 1) && (d.probs[1] * best.under.odds > 1);
  assert(!both, 'both legs cannot beat their own price');
});

console.log(`\n${failed === 0 ? '✓' : '✗'} market prob scale: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// ── THE FOUR REASONS A SECONDARY BOARD IS EMPTY, COUNTED APART ───────────────
//
// On 21 Aug 2026 the goals sheet had written 158 signals in a fortnight with 8
// scored, and that was read as migration 060's guard destroying the model's
// output. It was not. Three different things were happening and they present
// identically from outside:
//
//   * an incoherent two-way vector, correctly stripped by the guard;
//   * team_statistics stale for a week, so the model could not price at all;
//   * the model pricing fine and having NO EDGE — measured over 190 fixtures
//     on 21 Aug, the best leg averaged -2.75% and exactly one row was positive.
//
// `buildSecondarySignals` takes a census out-parameter so the run can say which.
// Without it "[secondary] no new signals" is the only evidence, and it is the
// same line for all four.

test('the census separates unpriced from priced-but-no-edge', () => {
  const census = {};
  // No odds at all → nothing to price. `bestTwoWay` returns null and the
  // fixture is counted as unpriced rather than as an absence of value.
  sm.buildSecondarySignals(
    { id: 'm1', odds: [], home_team: {}, away_team: {} }, null, null, null, null, census);
  assert.strictEqual(census.totals.unpriced, 1);
  assert.strictEqual(census.totals.priced, 0);
  assert.strictEqual(census.totals.value, 0);
  // `best` stays null: no leg was priced, so there is no best leg. Reporting 0
  // here would say "we priced it and found nothing", which is a different claim.
  assert.strictEqual(census.totals.best, null);
});

test('a census is optional, so every existing caller is unaffected', () => {
  // The out-parameter defaults to null and the function must behave identically
  // without it — this is the guard against a diagnostic changing what is written.
  const match = { id: 'm2', odds: [], home_team: {}, away_team: {} };
  const withCensus = sm.buildSecondarySignals(match, null, null, null, null, {});
  const without    = sm.buildSecondarySignals(match, null, null, null, null);
  assert.deepStrictEqual(without, withCensus);
});
