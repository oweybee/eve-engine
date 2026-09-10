/**
 * engine.posttox.broadcast.test.js — the Telegram gate reads BOTH ladders now.
 * Run: node engine.posttox.broadcast.test.js
 *
 * Live report, 10 Sep 2026: "bug signals still coming through on telegram"
 * after a fix that only touched the /performance record (eve-engine migration
 * 125 + eve-frontend lib/performance-query.ts). Neither of those objects is
 * anywhere near postToX.js, which has its own, separate broadcast decision.
 *
 * `run()`'s per-signal skip check read `tier !== 'prime'` — the ELIGIBILITY
 * ladder alone, straight from `classifyTier` — which was correct only until
 * 26 Aug 2026, when that ladder split its one suggested box into TWO tiers,
 * 'prime' and 'edge' (lib/signalTier.js). After the split:
 *
 *   - a genuinely BACKED 'edge'-tier signal (isBroadcastable === true) was
 *     dropped at that check, before ever reaching buildMessage's dedicated
 *     "EDGE SIGNAL" branch — a signal that should post, silently swallowed.
 *   - a 'prime'-eligibility-box signal whose actual SCORE fell below the
 *     backing line (isBroadcastable === false — SLIGHT/TRACE/NIL) sailed
 *     straight past that same check, because it only ever asked about the
 *     price+edge box and never asked about the score. It reached
 *     buildMessage and was posted under the catch-all "⚡ UNBACKED EDGE"
 *     branch — whose own comment claimed that exact case "does not reach the
 *     channel". It did: this is the "bug signal" the report was about.
 *
 * `isBroadcastable` already existed and already reads both ladders correctly
 * (it is what `broadcastableIds` was built from, one line above the bug) —
 * the fix is `run()` reading it too, instead of re-deriving the ladder from a
 * tier string a second time.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const { isBroadcastable, isSuggested } = require('./postToX.js');
const { classifyTier } = require('./lib/signalTier');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

test('an EDGE-tier signal at a backed score is broadcastable', () => {
  // odds 2.00 (in the box), edge 8% -> classifyTier tier 'edge', suggested.
  const row = { detected_odds: 2.00, detected_edge: 0.08, mxs: 50, gap_basis: 'devigged' };
  assert.strictEqual(classifyTier(row).tier, 'edge');
  assert.strictEqual(isSuggested(row), true);
  assert.strictEqual(isBroadcastable(row), true,
    'a backed EDGE-tier signal must be broadcastable — the old tier-string ' +
    'check dropped every one of these');
});

test('a PRIME-eligibility-box signal below the backing line is NOT broadcastable', () => {
  // odds 2.00, edge 6% -> classifyTier tier 'prime' (in the box), but a weak
  // score (TRACE) means the row is not actually backed.
  const row = { detected_odds: 2.00, detected_edge: 0.06, mxs: 20, gap_basis: 'devigged' };
  assert.strictEqual(classifyTier(row).tier, 'prime');
  assert.strictEqual(isBroadcastable(row), false,
    'a prime-box signal scoring below the backing line must not be ' +
    'broadcastable — this is the exact row that reached Telegram as ' +
    '"UNBACKED EDGE" before the fix');
});

test('a genuinely backed PRIME-tier signal is still broadcastable, unchanged', () => {
  const row = { detected_odds: 2.00, detected_edge: 0.06, mxs: 75, gap_basis: 'devigged' };
  assert.strictEqual(classifyTier(row).tier, 'prime');
  assert.strictEqual(isBroadcastable(row), true);
});

test('a longshot never reaches a backed rung, regardless of score', () => {
  const row = { detected_odds: 4.50, detected_edge: 0.08, mxs: 90, gap_basis: 'devigged' };
  assert.strictEqual(classifyTier(row).tier, 'longshot');
  assert.strictEqual(isBroadcastable(row), false);
});

/**
 * Source guard, not a behavioural test: `run()` reads network/Supabase state
 * and cannot be driven end to end here, so this pins the SHAPE of the fix
 * directly against the file text — the same technique this repo already uses
 * to guard a read that must not silently return (e.g. the DISCORD env-var
 * consumers). If a future edit reintroduces a bare `tier !== 'prime'` (or
 * `tier === 'prime'`) as the broadcast gate, this fails before a live report
 * has to find it again.
 */
test('the broadcast gate in run() reads isBroadcastable, not a bare tier string', () => {
  const src = fs.readFileSync(__dirname + '/postToX.js', 'utf8');
  assert.ok(
    /!isInplay\(signal\)\s*&&\s*!isMover\(signal\)\s*&&\s*!isBroadcastable\(signal\)/.test(src),
    'run() must skip on !isBroadcastable(signal) — both ladders together'
  );
  // The regression shape: a raw tier comparison used as the sole gate. Match
  // it OUTSIDE of comments/prose by looking for the executable form only.
  assert.ok(
    !/if\s*\([^)]*tier\s*!==\s*'prime'[^)]*\)\s*\{/.test(src),
    'the gate must not fall back to comparing classifyTier().tier against a ' +
    "literal 'prime' — that is exactly the check that went stale on 26 Aug"
  );
});

console.log(`\n${passed} passed`);
if (process.exitCode) process.exit(process.exitCode);
