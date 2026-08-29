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
const { insertOddsRows, prefetchLastOdds } = require('./ingestOdds');

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

// ---------------------------------------------------------------------------
// prefetchLastOdds — the price-movement baseline. A plain .in() capped the read
// at 1,000 rows across ALL matches, so matches beyond the cap lost their "last
// seen" price and every book re-signalled as a fake move. It is paged + chunked
// via lib/pagedRead now, which walks id-ascending — so recency must come from
// max(fetched_at), not from first-seen row order.
// ---------------------------------------------------------------------------

/** A supabase double for the odds table: honours .in()/.gte() filters, sorts on
 *  .order(), enforces the 1,000-row cap on .range(), and rebuilds per page. */
function oddsClient(rows, { cap = 1000 } = {}) {
  const make = () => {
    let f = rows;
    const node = {
      in: (col, ids) => { const s = new Set(ids); f = f.filter(r => s.has(r[col])); return node; },
      gte: (col, v) => { f = f.filter(r => r[col] >= v); return node; },
      order: (col, { ascending = true } = {}) => {
        f = [...f].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
        return node;
      },
      range: async (from, to) => ({ data: f.slice(from, from + Math.min(to - from + 1, cap)), error: null }),
    };
    return node;
  };
  return { from: () => ({ select: () => make() }) };
}

const rid = (i) => `r${String(i).padStart(5, '0')}`;
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

test('prefetchLastOdds pages past the cap and takes the latest by fetched_at', async () => {
  const rows = [
    // match z, book a: an OLD row early in id-order and a NEWER row late in it.
    { id: rid(0), match_id: 'z', bookmaker: 'a', market: 'h2h', market_line: null, home_odds: 2.0, fetched_at: ago(90) },
    // 1,000 rows for match x fill the whole first page (ids r00001..r01000)…
    ...Array.from({ length: 1000 }, (_, i) => ({
      id: rid(i + 1), match_id: 'x', bookmaker: `b${i}`, market: 'h2h', market_line: null, home_odds: 1.5, fetched_at: ago(30),
    })),
    // …so z's newer row is only reachable on page 2.
    { id: rid(1500), match_id: 'z', bookmaker: 'a', market: 'h2h', market_line: null, home_odds: 3.3, fetched_at: ago(1) },
  ];
  const map = await prefetchLastOdds(oddsClient(rows), ['x', 'z']);

  const z = map.get('z:a:h2h:');
  assert.ok(z, 'match z beyond the first page was still read');
  assert.strictEqual(z.home_odds, 3.3, 'the newer row won on fetched_at, not the id-first one');
  assert.strictEqual(map.get('x:b0:h2h:').home_odds, 1.5, 'first-page rows are present too');
});

test('prefetchLastOdds honours the 48h window and empty input', async () => {
  assert.strictEqual((await prefetchLastOdds(oddsClient([]), [])).size, 0);
  const rows = [
    { id: rid(1), match_id: 'm', bookmaker: 'a', market: 'h2h', market_line: null, home_odds: 2.0, fetched_at: ago(10) },
    { id: rid(2), match_id: 'm', bookmaker: 'a', market: 'h2h', market_line: null, home_odds: 9.9, fetched_at: ago(60 * 72) }, // 3 days old
  ];
  const map = await prefetchLastOdds(oddsClient(rows), ['m']);
  assert.strictEqual(map.get('m:a:h2h:').home_odds, 2.0, 'the stale 3-day row is filtered out by the .gte window');
});
