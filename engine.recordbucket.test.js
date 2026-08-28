'use strict';

// THE SETTLED RECORD IS READ, NOT RE-DERIVED.
//
// calculatePerformance asked classifyTier(odds, edge) to decide which rows fed
// the headline — a question answered with TODAY's thresholds. So every time the
// eligibility box moved, the settled record re-sorted itself: picks this engine
// had published as PRIME left their own history because a constant changed.
//
// Measured on production, 27 Aug 2026, settled prematch rows since the epoch,
// deduped: 85 rows / 42 wins / 49.4% from the stored bucket against 34 / 20 /
// 58.8% re-derived. Fifty-one published picks, twenty-two of them winners, and
// the number left standing was the FLATTERING one.
//
// The live case: Borac Banja Luka, published 25 Aug at 2.02 on a 4.14% edge,
// won — and was absent from the table that evening because PRIME_EDGE_MIN moved
// to 5% on the 26th.

const assert = require('assert');
const { calculatePerformance } = require('./fetchResults');

let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

// A signal published as prime under the box that was live at the time, whose
// edge today's 5% floor would re-file as 'value'.
const publishedPrime = (over = {}) => ({
  result: 'win', detected_odds: 2.02, detected_edge: 0.0414, detected_mes: 65,
  clv: null, no_vig_clv: null, phase: 'prematch',
  detected_at: '2026-08-25T13:32:14Z', match_id: 'm-borac', market: 'h2h',
  market_line: null, model_architecture: 'MARKET_ANCHORED',
  signal_category: 'prime', ...over,
});

function stub(rows) {
  const written = [];
  return {
    written,
    client: {
      from: (table) => ({
        select: async () => ({ data: rows, error: null }),
        upsert: async (payload) => { written.push(...payload); return { error: null }; },
      }),
    },
  };
}
const headline = written => written.find(r => r.singleton_key === 'current');

(async () => {
  console.log('\ncalculatePerformance — which rows feed the headline');

  await test('counts a pick published as prime that today\'s box would re-file', async () => {
    const s = stub([publishedPrime()]);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 1,
      'a 4.14% edge is below the 5% floor — re-deriving drops it, reading does not');
    assert.strictEqual(headline(s.written).wins, 1);
  });

  await test('does NOT count a pick published as value, whatever its numbers say', async () => {
    // The mirror. Reading the stored bucket has to cut both ways, or it is just
    // a wider net dressed up as a principle.
    const s = stub([publishedPrime({ signal_category: 'value', detected_edge: 0.0587 })]);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 0);
  });

  await test('keeps the EDGE band out of the headline (the 26 Aug ruling)', async () => {
    const s = stub([publishedPrime({ signal_category: 'edge', detected_edge: 0.085 })]);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 0,
      'edge is broadcast and settled, but the published record covers prime alone');
  });

  await test('a row with no stored bucket is classified live, never dropped', async () => {
    const s = stub([publishedPrime({ signal_category: null, detected_edge: 0.0587 })]);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 1,
      'production carries no nulls, and losing a settled signal is worse than dating one');
  });

  await test('the epoch still scopes it', async () => {
    const s = stub([publishedPrime({ detected_at: '2026-07-01T00:00:00Z' })]);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 0);
  });

  await test('a moved threshold cannot change a settled figure', async () => {
    // The property in one line: the same rows must produce the same headline
    // whatever PRIME_EDGE_MIN happens to be, because none of them is re-classified.
    const rows = [0.031, 0.0414, 0.0587, 0.085].map((e, i) => publishedPrime({
      detected_edge: e, match_id: `m-${i}`, signal_category: 'prime',
    }));
    const s = stub(rows);
    await calculatePerformance(s.client);
    assert.strictEqual(headline(s.written).settled_signals, 4,
      'all four were published as prime; three of them straddle floors that have moved');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
