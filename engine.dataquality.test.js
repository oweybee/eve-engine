/**
 * engine.dataquality.test.js — the hard predicate upstream of scoring.
 * Run: node engine.dataquality.test.js
 *
 * Every case here is a way a price can look fine and be worthless. Until §2.6
 * these all scored: odds_drift_pct ran 38–785% weekly and blocked nothing.
 */
'use strict';
const assert = require('assert');
const { checkQuality, thresholdsFromEnv, bookCount, meanPrice, dispersionPct,
        DEFAULTS } = require('./lib/dataQuality');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const NOW = new Date('2026-08-05T12:00:00Z');
const fresh = new Date(NOW.getTime() - 60_000).toISOString();     // 1 minute old
const stale = new Date(NOW.getTime() - 60 * 60_000).toISOString(); // 1 hour old

const good = {
  bestOdds: 3.40,
  allOdds: { bet365: 3.40, pinnacle: 3.30, william_hill: 3.25, unibet: 3.20 },
  booksInMarket: 17,
  oddsFetchedAt: fresh,
  now: NOW,
};

test('a well-priced, freshly captured selection passes', () => {
  const r = checkQuality(good);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.booksOnSelection, 4);
  assert.ok(r.ageMinutes < 2);
});

test('a thin market is rejected, whatever the price looks like', () => {
  const r = checkQuality({ ...good, booksInMarket: 2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /quoting the market/);
});

test('one book showing the selection is that book, not a market', () => {
  const r = checkQuality({ ...good, allOdds: { bet365: 3.40 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /selection priced at 1 book/);
});

test('a stale price is rejected', () => {
  const r = checkQuality({ ...good, oddsFetchedAt: stale });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /old, limit/);
  assert.ok(r.ageMinutes > 59);
});

test('a price with NO capture time fails — it does not default to fresh', () => {
  // The whole audit was about a missing value being filled with whatever was
  // available. An undated price must fail closed.
  for (const v of [null, undefined, '', 'not-a-date']) {
    const r = checkQuality({ ...good, oddsFetchedAt: v });
    assert.strictEqual(r.ok, false, `oddsFetchedAt=${v} must fail`);
  }
  assert.match(checkQuality({ ...good, oddsFetchedAt: null }).reason, /no capture timestamp/);
});

test('a price far off the pack is a palpable error, not an edge', () => {
  // 25.00 where the rest of the market is around 8.00 — the shape of the
  // Rijeka v Ilves row that carried a "+24.9% edge".
  const r = checkQuality({
    ...good,
    bestOdds: 25.0,
    allOdds: { rogue: 25.0, pinnacle: 8.0, bet365: 7.8, unibet: 8.2 },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /above the mean/);
});

test('a modest best-of-market premium still passes', () => {
  const r = checkQuality({
    ...good, bestOdds: 3.60,
    allOdds: { bet365: 3.60, pinnacle: 3.30, unibet: 3.25, williamhill: 3.20 },
  });
  assert.strictEqual(r.ok, true);
});

test('an unusable price is rejected before anything else is computed', () => {
  for (const p of [null, undefined, 0, 1, -3, 'x']) {
    const r = checkQuality({ ...good, bestOdds: p });
    assert.strictEqual(r.ok, false, `bestOdds=${p} must fail`);
    assert.strictEqual(r.reason, 'no usable price');
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('book counting and the mean ignore junk prices', () => {
  const odds = { a: 3.4, b: '3.2', c: null, d: 1, e: 'nonsense', f: 0 };
  assert.strictEqual(bookCount(odds), 2);
  assert.strictEqual(Math.round(meanPrice(odds) * 100) / 100, 3.3);
  assert.strictEqual(bookCount(null), 0);
  assert.strictEqual(meanPrice({}), null);
});

test('dispersion is null with nothing to compare against', () => {
  assert.strictEqual(dispersionPct(3.4, { a: 3.4 }), null);
  assert.strictEqual(dispersionPct(3.4, null), null);
  assert.strictEqual(dispersionPct(3.4, {}), null);
});

test('a single-book selection fails on book count, not silently on dispersion', () => {
  // Order matters: dispersion cannot be computed at n=1, so if the book-count
  // check were not first this candidate would sail through with disp = null.
  const r = checkQuality({ ...good, allOdds: { only: 99.0 }, bestOdds: 99.0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /need 2/);
});

// ── configuration ───────────────────────────────────────────────────────────

test('thresholds come from env, and fall back to the defaults', () => {
  assert.deepStrictEqual(thresholdsFromEnv({}), {
    minBooksInMarket:    DEFAULTS.minBooksInMarket,
    minBooksOnSelection: DEFAULTS.minBooksOnSelection,
    maxPriceAgeMinutes:  DEFAULTS.maxPriceAgeMinutes,
    maxDispersionPct:    DEFAULTS.maxDispersionPct,
  });
  const t = thresholdsFromEnv({ DQ_MIN_BOOKS_IN_MARKET: '5', DQ_MAX_PRICE_AGE_MINUTES: '2.5' });
  assert.strictEqual(t.minBooksInMarket, 5);
  assert.strictEqual(t.maxPriceAgeMinutes, 2.5);
  assert.strictEqual(t.maxDispersionPct, DEFAULTS.maxDispersionPct);
  // Garbage in env must not silently become NaN and disable a check.
  assert.strictEqual(thresholdsFromEnv({ DQ_MIN_BOOKS_IN_MARKET: 'lots' }).minBooksInMarket,
                     DEFAULTS.minBooksInMarket);
});

console.log(`\n${passed} test(s) passed`);
