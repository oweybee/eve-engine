'use strict';

/**
 * engine.insertsignals.test.js — a duplicate must cost one row, not the run.
 *
 * THIS IS NOT A TEST ABOUT ERROR HANDLING. `value_signals_selection_price_unique`
 * has no time bound and two of the four writers dedup only over the last 60
 * minutes, so a price re-quoted after sitting unchanged for an hour raises
 * 23505 — and every writer used to `throw`, which aborted the compute cycle
 * before secondary signals or bet-of-day ran.
 *
 * The property worth pinning is the one the first attempt at this fix got
 * wrong: a batch containing ONE duplicate must still write every other row.
 * Returning 0 on a collision reports genuinely-new signals as already-recorded,
 * which is the failure mode this repo keeps paying for — a job that computes
 * the right answer and discards it, presenting as a quiet market.
 */

const test = require('node:test');
const assert = require('node:assert');
const { insertSignals, UNIQUE_VIOLATION } = require('./lib/insertSignals');

/**
 * A fake PostgREST client whose unique index is `key`. Batch inserts fail
 * whole, exactly as one statement does.
 */
function fakeSupabase(existingKeys = [], { failWith = null } = {}) {
  const stored = new Set(existingKeys);
  const calls = { batch: 0, row: 0 };
  return {
    stored, calls,
    from() {
      return {
        insert(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          Array.isArray(payload) ? calls.batch++ : calls.row++;
          if (failWith) return Promise.resolve({ error: failWith });
          const clash = rows.some(r => stored.has(r.key));
          if (clash) {
            return Promise.resolve({ error: { code: UNIQUE_VIOLATION, message: 'duplicate key' } });
          }
          for (const r of rows) stored.add(r.key);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const rows = keys => keys.map(k => ({ key: k }));

test('the ordinary path is one batch insert', async () => {
  const db = fakeSupabase();
  const r = await insertSignals(db, rows(['a', 'b', 'c']), 'test');
  assert.deepStrictEqual(r, { inserted: 3, duplicate: 0 });
  assert.strictEqual(db.calls.batch, 1);
  assert.strictEqual(db.calls.row, 0, 'no row-by-row walk when nothing collides');
});

test('ONE duplicate does not cost the other rows', async () => {
  const db = fakeSupabase(['b']);
  const r = await insertSignals(db, rows(['a', 'b', 'c']), 'test');
  assert.deepStrictEqual(r, { inserted: 2, duplicate: 1 });
  assert.ok(db.stored.has('a') && db.stored.has('c'), 'the new rows landed');
});

test('a batch that is entirely duplicates inserts nothing and does not throw', async () => {
  const db = fakeSupabase(['a', 'b']);
  const r = await insertSignals(db, rows(['a', 'b']), 'test');
  assert.deepStrictEqual(r, { inserted: 0, duplicate: 2 });
});

test('an error that is NOT a unique violation still throws', async () => {
  const db = fakeSupabase([], { failWith: { code: '08006', message: 'connection failure' } });
  await assert.rejects(
    () => insertSignals(db, rows(['a']), 'test'),
    /test\(insert\): connection failure/,
    'a dropped connection must not be swallowed as already-recorded'
  );
});

test('a non-unique error during the row-by-row retry throws too', async () => {
  const stored = new Set(['a']);
  let seen = 0;
  const db = {
    from: () => ({
      insert(payload) {
        if (Array.isArray(payload)) {
          return Promise.resolve({ error: { code: UNIQUE_VIOLATION, message: 'duplicate key' } });
        }
        seen++;
        if (stored.has(payload.key)) {
          return Promise.resolve({ error: { code: UNIQUE_VIOLATION, message: 'duplicate key' } });
        }
        return Promise.resolve({ error: { code: '22P02', message: 'invalid input syntax' } });
      },
    }),
  };
  await assert.rejects(() => insertSignals(db, rows(['a', 'b']), 'test'), /invalid input syntax/);
  assert.strictEqual(seen, 2, 'it reached the second row before throwing');
});

test('an empty batch issues no request at all', async () => {
  const db = fakeSupabase();
  const r = await insertSignals(db, [], 'test');
  assert.deepStrictEqual(r, { inserted: 0, duplicate: 0 });
  assert.strictEqual(db.calls.batch + db.calls.row, 0);
});
