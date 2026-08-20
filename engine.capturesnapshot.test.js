'use strict';

/**
 * engine.capturesnapshot.test.js — the prefetch batching.
 *
 * THIS IS NOT A TEST ABOUT ARRAYS. captureSnapshot stopped writing
 * `odds_snapshots` entirely from 18 Aug 14:17 to 19 Aug 23:00 because its three
 * prefetches inlined every match id into a single `.in(...)` filter — 821 uuids,
 * a ~32KB request line — and the transport rejected it before Postgres saw it.
 * The workflow ran the script as `2>/dev/null || true`, so the step stayed green
 * the whole time.
 *
 * So the property worth pinning is the one that broke: no single request may
 * carry an unbounded id list, whatever the slate size.
 */

const test = require('node:test');
const assert = require('node:assert');
const { inChunks, IN_CHUNK } = require('./captureSnapshot');

const ids = (n) => Array.from({ length: n }, (_, i) => `id-${i}`);

/**
 * A fake PostgREST builder over a fixed row list, honouring order+range.
 * `inChunks` drives it through `pageAll`, so a test sees exactly what the
 * transport would do — including the 1000-row cap, if `cap` is set.
 */
function fakeQuery(rowsFor, { cap = null, onCall = null } = {}) {
  return (chunk) => {
    const rows = rowsFor(chunk);
    return {
      order: () => ({
        range: async (from, to) => {
          if (onCall) onCall(chunk, from, to);
          const width = cap == null ? (to - from + 1) : Math.min(to - from + 1, cap);
          return { data: rows.slice(from, from + width), error: null };
        },
      }),
    };
  };
}

const collect = (ids_, build) => inChunks(ids_, 'id', 'test', build);

test('NO BATCH EXCEEDS THE CHUNK SIZE, at any slate size', async () => {
  // 821 is the live figure that broke it; the others bracket the boundaries.
  for (const n of [0, 1, IN_CHUNK - 1, IN_CHUNK, IN_CHUNK + 1, 821, 5000]) {
    const seen = [];
    await collect(ids(n), fakeQuery(() => [], { onCall: (chunk) => seen.push(chunk.length) }));
    for (const size of seen) {
      assert.ok(size <= IN_CHUNK, `a batch of ${size} exceeds ${IN_CHUNK} at n=${n}`);
    }
  }
});

test('a uuid slate stays inside a sane URL budget', async () => {
  // The actual failure was bytes, not count — so assert bytes. A uuid is 36
  // chars and costs ~39 once quoted and comma-separated.
  const UUID_COST = 39;
  assert.ok(IN_CHUNK * UUID_COST < 8192,
    `a full chunk is ~${IN_CHUNK * UUID_COST} bytes of URL, over an 8KB budget`);
});

test('every id is visited exactly once, and in order', async () => {
  const input = ids(821);
  const seen = [];
  await collect(input, fakeQuery(() => [], {
    onCall: (chunk, from) => { if (from === 0) seen.push(...chunk); },
  }));
  assert.deepStrictEqual(seen, input);
});

test('rows from every batch are concatenated, not just the last', async () => {
  // The bug this guards: returning only the final chunk's rows would leave the
  // prefetch maps mostly empty and every fixture would look unsnapshotted.
  const out = await collect(ids(450), fakeQuery(chunk => chunk.map(id => ({ id }))));
  assert.strictEqual(out.length, 450);
  assert.strictEqual(out[0].id, 'id-0');
  assert.strictEqual(out[449].id, 'id-449');
});

test('an empty slate makes no request at all', async () => {
  let calls = 0;
  const out = await collect([], fakeQuery(() => [], { onCall: () => { calls++; } }));
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(out, []);
});

test('a batch that returns nothing does not abort the rest', async () => {
  const out = await collect(ids(600),
    fakeQuery(chunk => (chunk[0] === 'id-0' ? [] : chunk.map(id => ({ id })))));
  assert.strictEqual(out.length, 400);
});

test('an error propagates rather than being swallowed', async () => {
  // The prefetches throw on a Supabase error; that must reach the caller so the
  // run fails loudly. Silence is what cost 32 hours.
  await assert.rejects(
    () => inChunks(ids(300), 'id', 'prefetchBoom', () => ({
      order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }),
    })),
    /prefetchBoom: boom/);
});

/* ── EACH CHUNK IS PAGED, and that is a second cap ─────────────────────
   Chunking answers the URL LENGTH limit and says nothing about the ROW cap.
   Measured on production 20 Aug 2026: one 200-match chunk of odds_snapshots
   over 7 days is ~8,900 rows against a 1,000-row cap, so 86% of the existence
   Set was discarded on every run — and that Set is what decides `open` vs
   `current`. 22 board fixtures could never graduate however many times the
   loop ran, and both /api/match-card and /api/match-reads read `current`. */

test('A CHUNK LARGER THAN THE ROW CAP IS STILL RETURNED IN FULL', async () => {
  const PER_CHUNK = 8900;               // the measured live figure
  const rows = chunk => Array.from(
    { length: chunk.length === IN_CHUNK ? PER_CHUNK : 931 },
    (_, i) => ({ id: `${chunk[0]}-${i}` }));

  const out = await collect(ids(830), fakeQuery(rows, { cap: 1000 }));

  // 4 full chunks of 8,900 plus a 30-id remainder of 931.
  assert.strictEqual(out.length, 4 * PER_CHUNK + 931);
});

test('the walk restarts at 0 for each chunk, not at the previous offset', async () => {
  // A shared cursor across chunks would read past the end of every chunk but
  // the first and return almost nothing — the same silent-empty shape.
  const firstOffsets = [];
  await collect(ids(600), fakeQuery(() => [], {
    onCall: (chunk, from) => { if (chunk[0].endsWith('-0') || from === 0) firstOffsets.push(from); },
  }));
  assert.ok(firstOffsets.every(o => o === 0));
  assert.strictEqual(firstOffsets.length, 3, 'one zero-offset page per chunk');
});

/* ── The driving query is PAGED ────────────────────────────────────────────
   PostgREST caps a response at 1000 rows and says nothing about it.
   computed_values held 1,509, so 509 were silently dropped on every run —
   and with no `order by`, an arbitrary 509. Only 96 of those rows were
   upcoming fixtures, which is why the visible symptom was elsewhere: an
   anchor price existed for 11 of 65 board fixtures.                        */

test('pageAll walks past the 1000-row cap', async () => {
  const { pageAll, PAGE_SIZE } = require('./captureSnapshot');
  const total = 1509;
  const all = Array.from({ length: total }, (_, i) => ({ match_id: `m-${String(i).padStart(5, '0')}` }));
  const seen = [];

  const query = () => ({
    order: () => ({
      range: async (from, to) => {
        seen.push([from, to]);
        return { data: all.slice(from, to + 1), error: null };
      },
    }),
  });

  const out = await pageAll(query, 'match_id');
  assert.strictEqual(out.length, total, 'every row is returned, not the first page');
  assert.deepStrictEqual(out.map(r => r.match_id), all.map(r => r.match_id));
  assert.strictEqual(seen[0][0], 0);
  assert.strictEqual(seen[0][1], PAGE_SIZE - 1);
});

test('IT ORDERS — paging without one can skip a row and repeat another', async () => {
  const { pageAll } = require('./captureSnapshot');
  let orderedBy = null;
  const query = () => ({
    order: (col, opts) => {
      orderedBy = { col, opts };
      return { range: async () => ({ data: [], error: null }) };
    },
  });
  await pageAll(query, 'match_id');
  assert.strictEqual(orderedBy.col, 'match_id');
  assert.deepStrictEqual(orderedBy.opts, { ascending: true });
});

test('a short page ends the walk rather than looping forever', async () => {
  const { pageAll } = require('./captureSnapshot');
  let calls = 0;
  const query = () => ({
    order: () => ({
      range: async () => {
        calls++;
        return { data: calls === 1 ? [{ match_id: 'a' }] : [], error: null };
      },
    }),
  });
  const out = await pageAll(query, 'match_id');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(calls, 1, 'a page shorter than PAGE_SIZE is the end');
});

test('AN ERROR THROWS rather than truncating the corpus silently', async () => {
  const { pageAll } = require('./captureSnapshot');
  const query = () => ({
    order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }),
  });
  await assert.rejects(() => pageAll(query, 'id', 'computed_values'), /computed_values: boom/);
});

/* ── The latest quote is the LATEST, not the first to arrive ──────────────
   prefetchLatestOdds used to take the first occurrence of each
   (match, bookmaker) out of a `fetched_at DESC` result. That is "latest" only
   while the server's sort survives to here — and it does not once the read is
   paged, because pages are walked by `id` ascending. Comparing the timestamp
   is correct under any arrival order, which is the property worth holding
   whatever the transport does next. Getting this wrong prints a STALE PRICE
   under a live fixture, which is not a shape anything downstream can detect. */

const { prefetchLatestOdds } = require('./captureSnapshot');

/** A supabase double whose `odds` table returns `rows` in the given order. */
function oddsClient(rows) {
  return {
    from: () => ({
      select: () => ({
        in: () => ({
          eq: () => ({
            gte: () => ({
              order: () => ({
                range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

const quote = (id, fetched_at, home_odds) => ({
  id, match_id: 'm1', bookmaker: 'pinnacle', fetched_at, home_odds,
  draw_odds: 3.5, away_odds: 4.0,
});

test('THE LATEST QUOTE WINS WHATEVER ORDER THE ROWS ARRIVE IN', async () => {
  const early = quote(1, '2026-08-20T10:00:00Z', 2.00);
  const late  = quote(2, '2026-08-20T12:00:00Z', 2.50);

  for (const [label, rows] of [['ascending', [early, late]], ['descending', [late, early]]]) {
    const map = await prefetchLatestOdds(oddsClient(rows), ['m1'], '2026-08-18T00:00:00Z');
    const row = map.get('m1').get('pinnacle');
    assert.strictEqual(row.home_odds, 2.50, `took the stale quote in ${label} order`);
  }
});

test('a row with no readable timestamp never displaces one that has it', async () => {
  const dated   = quote(1, '2026-08-20T10:00:00Z', 2.00);
  const undated = quote(2, null, 9.99);
  const map = await prefetchLatestOdds(oddsClient([dated, undated]), ['m1'], '2026-08-18T00:00:00Z');
  assert.strictEqual(map.get('m1').get('pinnacle').home_odds, 2.00);
});

test('books are kept apart — one stale book cannot hide another', async () => {
  const rows = [
    { ...quote(1, '2026-08-20T10:00:00Z', 2.00) },
    { ...quote(2, '2026-08-20T09:00:00Z', 2.10), bookmaker: 'bet365' },
  ];
  const map = await prefetchLatestOdds(oddsClient(rows), ['m1'], '2026-08-18T00:00:00Z');
  assert.strictEqual(map.get('m1').size, 2);
  assert.strictEqual(map.get('m1').get('bet365').home_odds, 2.10);
});
