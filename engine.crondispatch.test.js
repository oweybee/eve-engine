'use strict';

/**
 * engine.crondispatch.test.js — the gh-watchdog freshness rule, isolated from
 * the network. scripts/gh-watchdog/ghWatchdog.js exists because GitHub's own
 * `schedule:` trigger is best-effort and has been observed silently dropping
 * for 8-11+ hours (28 Aug 2026: engine.yml's schedule went quiet from 05:36
 * UTC with a fixture kicking off in the gap, odds_snapshots 112min stale at
 * T-26min to kickoff). This pins WHEN that watchdog fires a workflow_dispatch
 * nudge, without touching Supabase or the GitHub API.
 *
 * Run: node engine.crondispatch.test.js
 */

const assert = require('assert');
const { evaluateFreshness } = require('./lib/cronDispatchDecision');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const NOW = new Date('2026-08-28T16:00:00Z');
const min = (n) => new Date(NOW.getTime() + n * 60000);

const DEFAULTS = { staleMinutes: 30, prekickoffWindowMinutes: 120, prekickoffStaleMinutes: 25 };

test('fresh snapshot, no upcoming fixture -> not stale', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-5), nextKickoffAt: null, now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, false);
});

test('gap over the flat ceiling with nothing upcoming -> stale', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-31), nextKickoffAt: null, now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.flatBreach, true);
  assert.strictEqual(r.prekickoffBreach, false);
});

test('gap exactly at the flat ceiling -> not stale (strict breach, matches the alert rule\'s own wording)', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-30), nextKickoffAt: null, now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, false);
});

test('never captured a snapshot -> stale, gap reads as Infinity rather than 0', () => {
  const r = evaluateFreshness({ latestSnapshotAt: null, nextKickoffAt: null, now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.gapMinutes, Infinity);
});

test('the 28 Aug incident shape: 112min gap, kickoff 26min away -> stale', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-112), nextKickoffAt: min(26), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, true);
});

test('gap under BOTH bars inside the pre-kickoff window -> not stale', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-20), nextKickoffAt: min(26), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, false);
});

test('gap over the tighter pre-kickoff bar but under the flat ceiling, OUTSIDE the window -> not stale', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-28), nextKickoffAt: min(200), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.inPrekickoffWindow, false);
  assert.strictEqual(r.stale, false);
});

test('gap over the tighter pre-kickoff bar, inside the window, under the flat ceiling -> stale via prekickoffBreach alone', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-28), nextKickoffAt: min(26), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.flatBreach, false);
  assert.strictEqual(r.prekickoffBreach, true);
});

test('kickoff exactly at the window edge counts as inside it', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-28), nextKickoffAt: min(120), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.inPrekickoffWindow, true);
  assert.strictEqual(r.stale, true);
});

test('a kickoff just past the window edge does not tighten the bar', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-28), nextKickoffAt: min(121), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.inPrekickoffWindow, false);
  assert.strictEqual(r.stale, false);
});

test('a kickoff in the past (should not occur given the caller filters kickoff_at > now, but must not invert the bar) -> outside the window', () => {
  const r = evaluateFreshness({ latestSnapshotAt: min(-28), nextKickoffAt: min(-5), now: NOW, ...DEFAULTS });
  assert.strictEqual(r.inPrekickoffWindow, false);
  assert.strictEqual(r.stale, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
