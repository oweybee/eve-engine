'use strict';

/**
 * engine.ingestodds.test.js — one request per fixture, not one per price.
 *
 * ingestOdds awaited a separate insert for EVERY odds row. Measured on run
 * 32376915580: 137 fixtures, 3,107 rows, 638 SECONDS — a flat ~160ms per row,
 * which is a network round-trip each and nothing else. That is why the engine
 * loop blew its own 300s budget, managed one iteration instead of four, and had
 * its later steps cancelled when the next scheduled run displaced it.
 *
 * THE HAZARD IN BATCHING IS THAT A BATCH IS ONE STATEMENT: a single malformed
 * row rejects all 36, which is strictly worse than the row-at-a-time version
 * that lost only the bad row. The per-row fallback is what makes batching safe,
 * and most of these tests exist to hold it in place.
 *
 * NOTE ON THE HARNESS. These live here rather than in engine.oddsapi.test.js
 * because that file's hand-rolled `test(n, f)` calls `f()` WITHOUT awaiting —
 * an async test that throws still prints a tick and increments the counter.
 * node:test awaits. A test that cannot fail is the bug this repo already fixed
 * once today in engine.lambda.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { insertOddsRows } = require('./ingestOdds');

/** A supabase double recording every insert call and its payload shape. */
function insertSpy({ failBatch = false, failRows = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    from: () => ({
      insert: async (payload) => {
        calls.push(payload);
        if (Array.isArray(payload)) {
          return failBatch ? { error: { message: 'batch boom' } } : { error: null };
        }
        return failRows.has(payload.bookmaker)
          ? { error: { message: `row boom ${payload.bookmaker}` } }
          : { error: null };
      },
    }),
  };
}

const entry = (bookmaker) => ({
  key: `m1:${bookmaker}:h2h:`,
  row: { bookmaker, market: 'h2h', home_odds: 2.0, draw_odds: 3.4, away_odds: 3.8 },
});

test('THE WHOLE FIXTURE GOES IN ONE REQUEST', async () => {
  const spy = insertSpy();
  const entries = ['pinnacle', 'bet365', 'unibet_uk'].map(entry);

  const { ok, failed } = await insertOddsRows(spy, 'm1', entries, () => {});

  assert.strictEqual(spy.calls.length, 1, 'one request, not one per row');
  assert.ok(Array.isArray(spy.calls[0]));
  assert.strictEqual(spy.calls[0].length, 3);
  assert.strictEqual(ok.length, 3);
  assert.strictEqual(failed, 0);
});

test('every row carries its match_id', async () => {
  const spy = insertSpy();
  await insertOddsRows(spy, 'match-abc', [entry('pinnacle'), entry('bet365')], () => {});
  for (const row of spy.calls[0]) assert.strictEqual(row.match_id, 'match-abc');
});

test('A BAD ROW CANNOT COST THE FIXTURE ITS OTHER PRICES', async () => {
  // The regression a naive .insert(array) would introduce: one statement, so
  // one rejected row loses all of them.
  const spy = insertSpy({ failBatch: true, failRows: new Set(['bet365']) });
  const named = [];
  const entries = ['pinnacle', 'bet365', 'unibet_uk'].map(entry);

  const { ok, failed } = await insertOddsRows(spy, 'm1', entries, (row) => named.push(row.bookmaker));

  assert.strictEqual(ok.length, 2, 'the good rows must still land');
  assert.deepStrictEqual(ok.map(e => e.row.bookmaker), ['pinnacle', 'unibet_uk']);
  assert.strictEqual(failed, 1);
  assert.deepStrictEqual(named, ['bet365'], 'the failing row is named, not swallowed');
  assert.strictEqual(spy.calls.length, 4, 'one batch attempt, then one per row');
});

test('the fallback costs nothing when the batch succeeds', async () => {
  const spy = insertSpy();
  await insertOddsRows(spy, 'm1', ['a', 'b', 'c', 'd'].map(entry), () => {});
  assert.strictEqual(spy.calls.length, 1, 'no per-row retry on the happy path');
});

test('an empty set of movers makes no request at all', async () => {
  const spy = insertSpy();
  const { ok, failed } = await insertOddsRows(spy, 'm1', [], () => {});
  assert.strictEqual(spy.calls.length, 0);
  assert.deepStrictEqual(ok, []);
  assert.strictEqual(failed, 0);
});

test('only the rows that LANDED are returned, so the price map cannot drift', async () => {
  // The caller sets lastOddsMap from `ok`. Returning a failed row there would
  // suppress its re-insert next cycle and the price would be lost in silence.
  const spy = insertSpy({ failBatch: true, failRows: new Set(['pinnacle', 'bet365']) });
  const { ok } = await insertOddsRows(spy, 'm1', ['pinnacle', 'bet365', 'x'].map(entry), () => {});
  assert.deepStrictEqual(ok.map(e => e.key), ['m1:x:h2h:']);
});

test('THESE TESTS CAN ACTUALLY FAIL', async () => {
  // The guard against the harness trap described in the header: prove the
  // runner surfaces a rejected async assertion rather than counting a tick.
  await assert.rejects(
    async () => { await insertOddsRows(insertSpy(), 'm1', [entry('a')], () => {});
                  assert.strictEqual(1, 2); },
    /1 !== 2|Expected values/);
});
