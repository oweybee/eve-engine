'use strict';

/**
 * engine.matchdetails.test.js — stop on a budget, do not get killed.
 *
 * fetchMatchDetails ran 191 matches at ~2s each against a 2-minute step
 * timeout, so it was SIGKILLed partway through on every run. Two things live
 * after the loop and were therefore discarded every time: the summary line, so
 * nothing recorded that it happened, and the `engine_plan.details_calls_used`
 * increment, so quota reporting has never once been updated by this script.
 *
 * Exactly the referee-aggregate loss in fetchTeamStats, in the step before it.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  isFresh, prefetchFreshness, isUpcoming, isRecentlyCompleted, TTL_MIN, BUDGET_SECONDS,
} = require('./fetchMatchDetails');

const NOW = Date.UTC(2026, 7, 20, 15, 0);
const ago = (mins) => new Date(NOW - mins * 60_000).toISOString();

test('THE BUDGET STAYS UNDER THE STEP TIMEOUT', () => {
  // The step allows 3 minutes. A budget at or above that is a budget that never
  // fires, which is the state this script was already in.
  assert.ok(BUDGET_SECONDS < 180,
    `budget ${BUDGET_SECONDS}s is not under the 180s step timeout — it would never stop first`);
});

test('the three TTLs differ, because the data does', () => {
  // A predictions model barely moves; a lineup changes up to kickoff; a
  // finished match's stats are final. One TTL for all three would either
  // re-fetch lineups too rarely or predictions far too often.
  assert.ok(TTL_MIN.predictions > TTL_MIN.lineups);
  assert.strictEqual(TTL_MIN.stats, Infinity, 'completed stats are final — fetch once');
});

test('A NEVER-FETCHED FIXTURE IS NEVER FRESH', () => {
  // Absent must mean "do the work". Treating a missing row as fresh would
  // permanently skip precisely the fixtures that have no data.
  const empty = new Map();
  assert.strictEqual(isFresh(empty, 123, 'predictions', NOW), false);
  assert.strictEqual(isFresh(empty, 123, 'lineups', NOW), false);
  assert.strictEqual(isFresh(empty, 123, 'stats', NOW), false);
});

test('freshness is per kind, on the same fixture and the same timestamp', () => {
  const m = new Map([[123, NOW - 60 * 60_000]]);   // fetched an hour ago
  assert.strictEqual(isFresh(m, 123, 'predictions', NOW), true,  '12h TTL — still fresh');
  assert.strictEqual(isFresh(m, 123, 'lineups', NOW), false, '20m TTL — stale, lineups move');
  assert.strictEqual(isFresh(m, 123, 'stats', NOW), true,  'final once written');
});

test('a fixture id matches whether it arrives as a number or a string', () => {
  // `matches.external_id` is text; the detail tables key on a numeric
  // fixture_id. A type mismatch here reads as "never fetched" and silently
  // re-fetches everything, spending the whole budget on repeat work.
  const m = new Map([[123, NOW - 60_000]]);
  assert.strictEqual(isFresh(m, '123', 'lineups', NOW), true);
  assert.strictEqual(isFresh(m, 123, 'lineups', NOW), true);
});

test('prefetchFreshness keeps the NEWEST row per fixture', async () => {
  // `lineups` holds one row per team, so a fixture has two. Taking whichever
  // arrived last would make freshness depend on row order.
  const rows = [
    { fixture_id: 7, fetched_at: ago(600) },
    { fixture_id: 7, fetched_at: ago(5) },
    { fixture_id: 8, fetched_at: null },
  ];
  const client = {
    from: () => ({ select: () => ({
      in: () => ({ order: () => ({ range: async () => ({ data: rows, error: null }) }) }),
    }) }),
  };
  const map = await prefetchFreshness(client, 'lineups', [7, 8]);
  assert.strictEqual(map.get(7), Date.parse(ago(5)), 'took the older of the two rows');
  assert.strictEqual(map.has(8), false, 'a null fetched_at is not a timestamp');
});

test('isUpcoming gates on DB status, not the clock', () => {
  // Our rows can sit as `scheduled` past nominal kickoff until results land.
  assert.strictEqual(isUpcoming({ status: 'scheduled' }), true);
  assert.strictEqual(isUpcoming({ status: 'live' }), true);
  assert.strictEqual(isUpcoming({ status: 'completed' }), false);
});

test('isRecentlyCompleted needs both a completed status and a kickoff', () => {
  assert.strictEqual(isRecentlyCompleted({ status: 'completed' }), false, 'no kickoff → cannot date it');
  assert.strictEqual(isRecentlyCompleted({ status: 'scheduled', kickoff_at: ago(60) }), false);
});
