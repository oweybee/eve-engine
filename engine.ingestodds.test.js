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
const { insertOddsRows, extractTotalsRows, isHalfLine } = require('./ingestOdds');

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


// ─────────────────────────────────────────────────────────────────────────────
// extractTotalsRows — half lines only, and why.
//
// bet id 5 returns TWENTY-ONE lines on a real Premier League fixture and we kept
// one. The other twenty are three settlement classes: .5 settles win/loss, whole
// lines PUSH (and `resultFromGoals` compares with strict > and <, so a push
// records as a LOSS), quarter lines settle half-win/half-loss and
// `value_signals_result_check` cannot store that at all. The predicate is the
// gate that keeps the last two out until settlement can handle them.
// ─────────────────────────────────────────────────────────────────────────────

const ou = values => ({ name: 'Bet365', bets: [{ id: 5, name: 'Goals Over/Under', values }] });
const pair = (line, o, u) => ([
  { value: `Over ${line}`, odd: String(o) }, { value: `Under ${line}`, odd: String(u) },
]);

test('isHalfLine admits .5 and rejects whole and quarter lines', () => {
  for (const l of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]) assert.ok(isHalfLine(l), `${l}`);
  for (const l of [1, 2, 3, 4.0, 1.25, 1.75, 2.25, 2.75, 4.75]) assert.ok(!isHalfLine(l), `${l}`);
  for (const l of [NaN, Infinity]) assert.ok(!isHalfLine(l));
});

test('emits one row per half line, sorted, both sides present', () => {
  const rows = extractTotalsRows(ou([
    ...pair(1.5, 1.40, 2.90), ...pair(2.5, 2.10, 1.72), ...pair(3.5, 4.00, 1.22),
  ]));
  assert.deepStrictEqual(rows.map(r => r.market_line), [1.5, 2.5, 3.5]);
  assert.deepStrictEqual(rows.map(r => [r.home_odds, r.away_odds]),
    [[1.40, 2.90], [2.10, 1.72], [4.00, 1.22]]);
  assert.ok(rows.every(r => r.market === 'totals' && r.draw_odds === null));
});

test('whole and quarter lines are dropped even when both sides are quoted', () => {
  const rows = extractTotalsRows(ou([
    ...pair(2.0, 2.00, 1.80), ...pair(2.25, 1.95, 1.85),
    ...pair(2.75, 2.40, 1.55), ...pair(2.5, 2.10, 1.72),
  ]));
  assert.deepStrictEqual(rows.map(r => r.market_line), [2.5]);
});

test('a one-legged line is not written', () => {
  const rows = extractTotalsRows(ou([
    { value: 'Over 3.5', odd: '4.00' },            // no Under 3.5
    ...pair(2.5, 2.10, 1.72),
  ]));
  assert.deepStrictEqual(rows.map(r => r.market_line), [2.5]);
});

test('junk prices drop their line rather than half-writing it', () => {
  const rows = extractTotalsRows(ou([
    { value: 'Over 1.5', odd: '1.00' },            // <= 1
    { value: 'Under 1.5', odd: '2.90' },
    { value: 'Over 4.5', odd: '1200' },            // > 999
    { value: 'Under 4.5', odd: '1.02' },
    ...pair(2.5, 2.10, 1.72),
  ]));
  assert.deepStrictEqual(rows.map(r => r.market_line), [2.5]);
});

test('the full 21-line payload yields exactly the eight half lines', () => {
  const all = [];
  for (const l of [0.5, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25,
                   3.5, 3.75, 4.0, 4.25, 4.5, 4.75, 5.0, 5.5, 6.5, 7.5]) {
    all.push(...pair(l, 2.00, 1.80));
  }
  assert.deepStrictEqual(extractTotalsRows(ou(all)).map(r => r.market_line),
    [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
});

test('no bet 5 on the bookmaker → nothing', () => {
  assert.deepStrictEqual(extractTotalsRows({ name: 'Bet365', bets: [{ id: 1, values: [] }] }), []);
  assert.deepStrictEqual(extractTotalsRows({}), []);
});
