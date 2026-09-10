'use strict';

/**
 * engine.postledger.test.js — the post ledger is a CLAIM, not a receipt.
 *
 * On 10 Sep 2026 the Telegram channel sent the same ten signals on three
 * consecutive ticks. `markPosted` upserted with ON CONFLICT DO UPDATE, so the
 * UNIQUE (signal_id, channel) constraint could never refuse anything; the only
 * dedupe was a read taken minutes earlier, and that read was unordered and
 * unpaged against 1,113 rows behind PostgREST's 1000-row ceiling. Worse, the
 * upsert's UPDATE rewrote each tuple to the end of the heap, which is exactly
 * the truncated tail — so re-sending a signal is what guaranteed it would be
 * re-sent again. All ten sat at physical ranks 1096–1113 of 1113.
 *
 * Two more mechanisms surfaced the same day and neither is closed by the
 * above. A re-detection at a moved price writes a BRAND NEW value_signals row
 * with a new id (#116), so a ledger keyed on signal_id cannot recognise the
 * repeat. And THREE workflows run postToX.js concurrently — engine.yml,
 * run-engine.yml and runInplayLoop.js — so any dedupe that is a READ has all
 * three reading "not posted" before any of them writes.
 *
 * These pin the shape that cannot fail any of those ways: an atomic claim on
 * the SELECTION (migration 125), taken before the send, confirmed after;
 * released ONLY on proof that nothing was delivered.
 *
 * Run: node engine.postledger.test.js   (zero deps beyond the app's own, no DB/network)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'postToX.js'), 'utf8');
// Comments are stripped before scanning: a ratchet that fires on the prose
// explaining the bug it guards is one the next person deletes.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const { deliver, loadPostedIds } = require('./postToX.js');

// Every case is queued and awaited in order. An earlier draft printed the
// tally from a setTimeout, which can report a pass before the async cases have
// resolved — a suite that can under-count is a suite that guards nothing.
let passed = 0, failed = 0;
const queue = [];
function test(label, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ✓ ${label}`); passed++; }
    catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
  });
}
function section(label) { queue.push(async () => console.log(label)); }

// ---------------------------------------------------------------- the writes

section('the forbidden writes');

test('no upsert against posted_signals anywhere in the broadcaster', () => {
  assert.ok(!/\.upsert\s*\(/.test(CODE),
    'an upsert always succeeds, so the UNIQUE constraint stops being a guard');
});

test('no ON CONFLICT DO UPDATE — onConflict is never passed', () => {
  assert.ok(!/onConflict/.test(CODE),
    'ON CONFLICT DO UPDATE is what let a resend overwrite the record of the first send');
});

test('posted_at is never written from application code', () => {
  assert.ok(!/posted_at\s*:/.test(CODE),
    'posted_at defaults to now() and is the record of FIRST publication');
});

test('the three claim RPCs are the only ledger writes', () => {
  for (const fn of ['claim_selection_post', 'confirm_signal_post', 'release_signal_post']) {
    assert.ok(CODE.includes(fn), `${fn} must be called`);
  }
  // The only .from('posted_signals') left is the read pre-filter.
  const froms = CODE.match(/\.from\(\s*'posted_signals'\s*\)/g) ?? [];
  assert.strictEqual(froms.length, 1, 'posted_signals should be touched directly only by the read pre-filter');
});

test('the pre-filter read is PAGED and ordered', () => {
  const fn = CODE.slice(CODE.indexOf('async function loadPostedIds'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/\.range\(/.test(body), 'an unpaged read is capped at 1000 rows by PostgREST');
  assert.ok(/\.order\(/.test(body), 'without an ORDER BY, .range() offsets index into an unspecified order');
});

// ------------------------------------------------------------------- deliver

function fakeSupabase(claimId, opts = {}) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_selection_post') {
        return Promise.resolve(opts.claimError
          ? { data: null, error: { message: 'boom' } }
          : { data: claimId, error: null });
      }
      return Promise.resolve({ data: true, error: null });
    },
  };
}
const SIGNAL = { id: 'sig-1' };
const names = sb => sb.calls.map(c => c.name);

section('\nclaim → send → confirm');

test('a won claim sends, then confirms with the platform message id', async () => {
  const sb = fakeSupabase('claim-1');
  let sent = 0;
  const r = await deliver(sb, SIGNAL, 'hash', async () => { sent++; return { message_id: 254 }; });
  assert.strictEqual(r.outcome, 'sent');
  assert.strictEqual(sent, 1);
  assert.deepStrictEqual(names(sb), ['claim_selection_post', 'confirm_signal_post']);
  const confirm = sb.calls[1].args;
  assert.strictEqual(confirm.p_claim_id, 'claim-1');
  assert.strictEqual(confirm.p_external_msg_id, '254', 'the message id travels as text');
});

test('the claim is taken BEFORE the send, not after it', async () => {
  const sb = fakeSupabase('claim-1');
  const order = [];
  const orig = sb.rpc.bind(sb);
  sb.rpc = (n, a) => { order.push(n); return orig(n, a); };
  await deliver(sb, SIGNAL, 'hash', async () => { order.push('SEND'); return { message_id: 1 }; });
  assert.deepStrictEqual(order, ['claim_selection_post', 'SEND', 'confirm_signal_post']);
});

test('a null claim is the ordinary case: nothing is sent, nothing is an error', async () => {
  const sb = fakeSupabase(null);
  let sent = 0;
  const r = await deliver(sb, SIGNAL, 'hash', async () => { sent++; return { message_id: 1 }; });
  assert.strictEqual(r.outcome, 'already_published');
  assert.strictEqual(sent, 0, 'a signal already published must not be sent again');
  assert.deepStrictEqual(names(sb), ['claim_selection_post'], 'no confirm, no release');
});

test('a claim RPC error is raised, never swallowed into a send', async () => {
  const sb = fakeSupabase(null, { claimError: true });
  await assert.rejects(() => deliver(sb, SIGNAL, 'hash', async () => ({ message_id: 1 })),
    /claim_selection_post/);
});

section('\nfailure — release only on proof of non-delivery');

test('a Telegram rejection releases the claim, so the signal retries next run', async () => {
  const sb = fakeSupabase('claim-1');
  const err = new Error('Telegram error 403: forbidden');
  err.telegramRejected = true;
  const r = await deliver(sb, SIGNAL, 'hash', async () => { throw err; });
  assert.strictEqual(r.outcome, 'refused');
  assert.deepStrictEqual(names(sb), ['claim_selection_post', 'release_signal_post']);
  assert.strictEqual(sb.calls[1].args.p_claim_id, 'claim-1');
});

test('a TRANSPORT failure keeps the claim — the message may have landed', async () => {
  // This is the one place the shape deviates from "release on any error", and
  // it is deliberate: a timeout is not proof of anything. Releasing here hands
  // back the duplicate this whole change exists to remove.
  for (const msg of ['Telegram timeout', 'socket hang up', 'ECONNRESET']) {
    const sb = fakeSupabase('claim-1');
    const r = await deliver(sb, SIGNAL, 'hash', async () => { throw new Error(msg); });
    assert.strictEqual(r.outcome, 'uncertain', msg);
    assert.deepStrictEqual(names(sb), ['claim_selection_post'], `${msg}: the claim must stand`);
  }
});

test('the claim is asked to dedupe by SELECTION by default', async () => {
  // A re-detection at a moved price is a new row id, so a claim on the row id
  // alone always wins and always re-sends. The selection is the only key the
  // repeat shares with the post it repeats.
  const sb = fakeSupabase('claim-1');
  await deliver(sb, SIGNAL, 'hash', async () => ({ message_id: 1 }));
  assert.strictEqual(sb.calls[0].args.p_dedupe_selection, true);
});

test('a MOVER claims with selection dedupe OFF, so its re-alert is not blocked', async () => {
  const sb = fakeSupabase('claim-1');
  await deliver(sb, SIGNAL, 'hash', async () => ({ message_id: 1 }), false);
  assert.strictEqual(sb.calls[0].args.p_dedupe_selection, false);
});

test('the run id and channel travel with the claim', async () => {
  const sb = fakeSupabase('claim-1');
  await deliver(sb, SIGNAL, 'hash', async () => ({ message_id: 1 }));
  const a = sb.calls[0].args;
  assert.strictEqual(a.p_signal_id, 'sig-1');
  assert.strictEqual(a.p_channel, 'telegram');
  assert.strictEqual(a.p_message_hash, 'hash');
});

test('the SEND SITE asks for selection dedupe on everything but a mover', () => {
  // Without this, flipping the call site to a constant `false` turns selection
  // dedupe off for the whole channel — the exact bug this change removes —
  // and every unit case above still passes, because they call deliver directly.
  assert.ok(
    /deliver\(\s*supabase,\s*signal,\s*messageHash,\s*send,\s*!isMover\(signal\)\s*\)/.test(CODE),
    'run() must pass !isMover(signal) as deliver\'s dedupeSelection argument');
});

test('the SELECTION KEY is never built in JavaScript for the claim', () => {
  // market_line is unconstrained numeric, so 2.5 and 2.50 both store and
  // render differently as text. A key built here and a key built in SQL would
  // agree until the day they did not; the database computes it.
  const fn = CODE.slice(CODE.indexOf('async function claimPost'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/selectionKey/.test(body),
    'claimPost must pass a boolean, never a key it composed itself');
});

test('a suppressed signal takes the claim and never confirms it', async () => {
  // Below the bar, a conflict loser, or no channel: claimed so it is not
  // reconsidered every tick, unconfirmed because nothing was sent.
  const sb = fakeSupabase('claim-1');
  const r = await deliver(sb, SIGNAL, 'hash', null);
  assert.strictEqual(r.outcome, 'claimed');
  assert.deepStrictEqual(names(sb), ['claim_selection_post']);
});

test('a failed confirm does not fail the run — the claim already blocks a resend', async () => {
  const sb = {
    calls: [],
    rpc(name, args) {
      this.calls.push({ name, args });
      if (name === 'claim_selection_post') return Promise.resolve({ data: 'claim-1', error: null });
      return Promise.resolve({ data: null, error: { message: 'confirm down' } });
    },
  };
  const r = await deliver(sb, SIGNAL, 'hash', async () => ({ message_id: 9 }));
  assert.strictEqual(r.outcome, 'sent', 'the message went out; only the id was lost');
});

// -------------------------------------------------------------- the pre-read

section('\nthe pre-filter read');

function pagingSupabase(total, { ignoreRange = false } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ signal_id: `s${i}` }));
  let pages = 0;
  const q = {
    select: () => q, eq: () => q, gte: () => q, order: () => q,
    range: (from, to) => {
      pages++;
      const slice = ignoreRange ? rows.slice(0, to - from + 1) : rows.slice(from, to + 1);
      return Promise.resolve({ data: slice, error: null });
    },
  };
  return { pages: () => pages, from: () => q };
}

test('it reads past 1000 rows — 1,113 is what the incident window held', async () => {
  const sb = pagingSupabase(1113);
  const ids = await loadPostedIds(sb);
  assert.strictEqual(ids.size, 1113, 'a single unpaged read would have returned 1000');
});

test('it dedupes by id, so a layer ignoring the Range header cannot loop', async () => {
  const sb = pagingSupabase(1113, { ignoreRange: true });
  const ids = await loadPostedIds(sb);
  assert.strictEqual(ids.size, 1000);
  assert.ok(sb.pages() <= 2, `stopped after ${sb.pages()} identical pages, not MAX_PAGES`);
});

test('a short page ends the walk', async () => {
  const sb = pagingSupabase(12);
  await loadPostedIds(sb);
  assert.strictEqual(sb.pages(), 1);
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
