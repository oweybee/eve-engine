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

test('NO BATCH EXCEEDS THE CHUNK SIZE, at any slate size', async () => {
  // 821 is the live figure that broke it; the others bracket the boundaries.
  for (const n of [0, 1, IN_CHUNK - 1, IN_CHUNK, IN_CHUNK + 1, 821, 5000]) {
    const seen = [];
    await inChunks(ids(n), async (chunk) => { seen.push(chunk.length); return []; });
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
  await inChunks(input, async (chunk) => { seen.push(...chunk); return []; });
  assert.deepStrictEqual(seen, input);
});

test('rows from every batch are concatenated, not just the last', async () => {
  // The bug this guards: returning only the final chunk's rows would leave the
  // prefetch maps mostly empty and every fixture would look unsnapshotted.
  const out = await inChunks(ids(450), async (chunk) => chunk.map(id => ({ id })));
  assert.strictEqual(out.length, 450);
  assert.strictEqual(out[0].id, 'id-0');
  assert.strictEqual(out[449].id, 'id-449');
});

test('an empty slate makes no request at all', async () => {
  let calls = 0;
  const out = await inChunks([], async () => { calls++; return []; });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(out, []);
});

test('a batch that returns nothing does not abort the rest', async () => {
  const out = await inChunks(ids(600), async (chunk) =>
    (chunk[0] === 'id-0' ? [] : chunk.map(id => ({ id }))));
  assert.strictEqual(out.length, 400);
});

test('an error propagates rather than being swallowed', async () => {
  // The prefetches throw on a Supabase error; that must reach the caller so the
  // run fails loudly. Silence is what cost 32 hours.
  await assert.rejects(
    () => inChunks(ids(300), async () => { throw new Error('prefetch boom'); }),
    /prefetch boom/);
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
  await assert.rejects(() => pageAll(query, 'match_id'), /paged read \(match_id\): boom/);
});
