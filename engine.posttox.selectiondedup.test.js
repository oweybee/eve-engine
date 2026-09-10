/**
 * engine.posttox.selectiondedup.test.js — one message per selection, not per row.
 * Run: node engine.posttox.selectiondedup.test.js
 *
 * Live incident, 10 Sep 2026 ("bug signals still coming through on telegram",
 * then "another Prime Signal notification for Mariehamn vs Turku PS has just
 * triggered AGAIN ... bombarding my subscribers with meaningless repeats").
 * Confirmed in production, unrelated to the isBroadcastable fix from the same
 * day: `value_signals_selection_price_unique` includes `detected_odds`, so a
 * re-detection at a moved price writes a brand new row with a brand new id --
 * pre-match on a re-poll, in-play on the next tick. `loadPostedIds` dedupes by
 * that row id, which two re-detections of the exact same claim never share.
 *
 * Measured directly against production: one live match (Portland Timbers v
 * St. Louis City) posted "away to win" FOUR times in eighteen minutes, each a
 * fresh id at a shrinking price (1.571 -> 1.533 -> 1.500 -> 1.400); a
 * pre-match PRIME signal (Mariehamn v Turku PS) repeated the same way. Every
 * individual post was honestly scored -- the failure is that a subscriber was
 * told the same thing more than once with no way to tell the fourth message
 * came from a different row than the first.
 */
'use strict';
const assert = require('assert');
const { selectionKey, loadPostedSelectionsFor } = require('./postToX.js');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}
async function atest(n, f) {
  try { await f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

test('selectionKey is the same for the four re-detected Portland Timbers rows', () => {
  // The actual production rows, minus id and price/edge -- the fields that
  // changed on every re-detection and are exactly what must NOT be the key.
  const base = { match_id: '9375fdd2-4e4b-4eaf-9fc8-32d360b85ba7', market: 'h2h', market_line: null, outcome: 'away' };
  const rows = [
    { ...base, detected_odds: 1.571, detected_edge: 0.1425 },
    { ...base, detected_odds: 1.533, detected_edge: 0.1519 },
    { ...base, detected_odds: 1.500, detected_edge: 0.1715 },
    { ...base, detected_odds: 1.400, detected_edge: 0.1824 },
  ];
  const keys = new Set(rows.map(selectionKey));
  assert.strictEqual(keys.size, 1, 'four re-detections of one claim must share one selection key');
});

test('selectionKey tells two different outcomes on the same match apart', () => {
  const base = { match_id: 'm1', market: 'h2h', market_line: null };
  assert.notStrictEqual(selectionKey({ ...base, outcome: 'home' }), selectionKey({ ...base, outcome: 'away' }));
});

test('selectionKey tells two different lines on the same market apart', () => {
  const base = { match_id: 'm1', market: 'totals', outcome: 'over' };
  assert.notStrictEqual(selectionKey({ ...base, market_line: 2.5 }), selectionKey({ ...base, market_line: 3.5 }));
});

test('selectionKey tells two different matches apart even with the same market shape', () => {
  const base = { market: 'h2h', market_line: null, outcome: 'home' };
  assert.notStrictEqual(selectionKey({ ...base, match_id: 'm1' }), selectionKey({ ...base, match_id: 'm2' }));
});

test('a null market_line does not collide with an explicit 0', () => {
  // Both stringify through the template literal, but a totals line of 0 is a
  // real (if unusual) line and must not read the same as h2h's "no line".
  const a = selectionKey({ match_id: 'm1', market: 'totals', market_line: null, outcome: 'over' });
  const b = selectionKey({ match_id: 'm1', market: 'totals', market_line: 0, outcome: 'over' });
  assert.notStrictEqual(a, b);
});

/** A minimal fake of the one PostgREST chain `loadPostedSelectionsFor` calls. */
function fakeSupabase(rows) {
  return {
    from(table) {
      assert.strictEqual(table, 'value_signals');
      return {
        select(cols) {
          assert.ok(cols.includes('posted_signals!inner'), 'must inner-join posted_signals, or an unposted row would count as posted');
          return {
            eq(col, val) {
              assert.strictEqual(col, 'posted_signals.channel');
              assert.strictEqual(val, 'telegram');
              return {
                in(col2, ids) {
                  assert.strictEqual(col2, 'match_id');
                  return Promise.resolve({ data: rows.filter(r => ids.includes(r.match_id)), error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

const fs = require('fs');
test('run() checks postedSelections before deciding to post, and updates it in-run', () => {
  const src = fs.readFileSync(__dirname + '/postToX.js', 'utf8');
  assert.ok(
    /postedSelections\.has\(selectionKey\(signal\)\)/.test(src),
    'the loop must skip a signal whose selection was already posted'
  );
  assert.ok(
    /postedSelections\.add\(selectionKey\(signal\)\)/.test(src),
    'a selection claimed this run must not be posted twice in the same run, ' +
    'before the database round trip that would catch it next run'
  );
  // Movers are the one deliberate exception -- an odds-movement alert IS a
  // second message about an existing signal, by design.
  assert.ok(
    /!isMover\(signal\)\s*&&\s*postedSelections\.has/.test(src),
    'the selection gate must exempt movers, or a genuine price-move alert ' +
    'would be silently swallowed by the very post it is reporting on'
  );
});

(async () => {
  await atest('loadPostedSelectionsFor returns the selection identity, not the row id', async () => {
    const supabase = fakeSupabase([
      { match_id: 'm1', market: 'h2h', market_line: null, outcome: 'away' },
    ]);
    const keys = await loadPostedSelectionsFor(supabase, ['m1']);
    assert.strictEqual(keys.has(selectionKey({ match_id: 'm1', market: 'h2h', market_line: null, outcome: 'away' })), true);
    // A DIFFERENT outcome on the same match must not be marked already-posted.
    assert.strictEqual(keys.has(selectionKey({ match_id: 'm1', market: 'h2h', market_line: null, outcome: 'home' })), false);
  });

  await atest('loadPostedSelectionsFor with no candidate matches issues no query', async () => {
    const supabase = { from() { throw new Error('must not query with an empty match id list'); } };
    const keys = await loadPostedSelectionsFor(supabase, []);
    assert.strictEqual(keys.size, 0);
  });

  console.log(`\n${passed} passed`);
  if (process.exitCode) process.exit(process.exitCode);
})();
