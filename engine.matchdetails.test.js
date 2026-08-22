'use strict';

/**
 * engine.matchdetails.test.js — the step that had never captured an XI on time.
 *
 * `fetchMatchDetails.queryMatches` asked for
 *     status in (scheduled,live) AND kickoff_at <= now()+48h
 * with NO LOWER BOUND on kickoff_at. Every fixture the feed never settled
 * stayed in the work list for ever — 47 of them on 22 Aug 2026, the oldest
 * kicking off 23 Oct 2022, the same zombie cohort the board drops silently.
 *
 * They were not free, and that is what hid this. API-Football serves the
 * historical XI for a game played in 2022, so each one is a SUCCESSFUL call
 * writing a row nobody reads. Measured on production, 22 Aug 2026:
 *
 *     lineup rows ever written                1,362
 *     fetched BEFORE kickoff                     26   (1.9%)
 *     fetched AFTER kickoff                   1,336
 *     mean lateness                          11.4 days
 *
 * On the 10:49 run all 18 lineups written were for fixtures from 2022, 2023
 * and 2025, while not one of the 25 fixtures kicking off inside the hour got
 * theirs — including a Premier League tie 41 minutes from kickoff, whose page
 * told the reader "lineups are published about an hour before kickoff".
 *
 * This is the SAME BUG fetchTeamStats.js was fixed for on 20 Aug, in the step
 * directly below this one. See engine.teamstats.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  inLineupWindow, isUpcoming, isRecentlyCompleted, chunk,
  PAST_GRACE_HOURS, AHEAD_HOURS, LINEUP_WINDOW_MINUTES,
  PREDICTION_REFRESH_HOURS, BUDGET_SECONDS, ID_CHUNK,
} = require('./fetchMatchDetails');

const SRC = fs.readFileSync(require.resolve('./fetchMatchDetails.js'), 'utf8');
const at = mins => new Date(Date.now() + mins * 60_000).toISOString();

// ---------------------------------------------------------------------------
// The bound that did not exist
// ---------------------------------------------------------------------------

test('THE WORK LIST IS BOUNDED AT BOTH ENDS', () => {
  assert.ok(PAST_GRACE_HOURS > 0 && PAST_GRACE_HOURS <= 24,
    'a still-scheduled fixture from 2022 must not be in the work list');
  assert.ok(AHEAD_HOURS > 0 && AHEAD_HOURS <= 72);
});

test('queryMatches states a LOWER bound on kickoff_at', () => {
  // A source assertion, because the bound lives in a Supabase query builder
  // and its absence is invisible: the query succeeds, the calls succeed, and
  // the rows written are simply the wrong ones.
  const q = SRC.slice(SRC.indexOf('async function queryMatches'),
                      SRC.indexOf('function chunk('));
  assert.ok(/\.gte\('kickoff_at'/.test(q), 'missing the lower bound — the 2022 zombies are back');
  assert.ok(/\.lte\('kickoff_at'/.test(q), 'missing the upper bound');
  assert.ok(/\.order\('kickoff_at'/.test(q),
    'unordered: with a work list longer than the budget, which fixtures get asked is arbitrary');
});

// ---------------------------------------------------------------------------
// The lineup window
// ---------------------------------------------------------------------------

test('the lineup window opens near kickoff and not two days out', () => {
  assert.ok(LINEUP_WINDOW_MINUTES >= 60,
    'an XI lands about an hour out; a window under 60m would miss it');
  assert.ok(LINEUP_WINDOW_MINUTES <= 240,
    'asking two days out is a guaranteed empty response and spends the budget');
});

test('inLineupWindow admits the imminent and refuses the distant', () => {
  const sched = ko => ({ status: 'scheduled', kickoff_at: ko });
  assert.equal(inLineupWindow(sched(at(25))), true,  '25 minutes out — the reported fixture');
  assert.equal(inLineupWindow(sched(at(59))), true);
  assert.equal(inLineupWindow(sched(at(60 * 47))), false, '47 hours out — no XI exists');
});

test('IT IS GATED ON THE CLOCK, NOT ON STATUS', () => {
  // Production has never written status='live', and a fixture sits at
  // 'scheduled' until fetchResults settles it. A status-based test would
  // never open the window at all.
  const kickedOff = { status: 'scheduled', kickoff_at: at(-20) };
  assert.equal(inLineupWindow(kickedOff), true,
    'a scheduled row 20 minutes past kickoff certainly has an XI published');
  assert.equal(isUpcoming({ status: 'live' }), true);
  assert.equal(inLineupWindow({ status: 'completed', kickoff_at: at(-20) }), false);
});

test('a malformed or absent kickoff refuses rather than throwing', () => {
  assert.equal(inLineupWindow({ status: 'scheduled', kickoff_at: null }), false);
  assert.equal(inLineupWindow({ status: 'scheduled', kickoff_at: 'not a date' }), false);
  assert.equal(inLineupWindow({}), false);
});

// ---------------------------------------------------------------------------
// Stopping is not being killed
// ---------------------------------------------------------------------------

test('THE SCRIPT STOPS ITSELF BEFORE THE STEP KILLS IT', () => {
  const STEP_TIMEOUT_SECONDS = 2 * 60;   // .github/workflows/engine.yml, step `details`
  assert.ok(BUDGET_SECONDS < STEP_TIMEOUT_SECONDS,
    `budget ${BUDGET_SECONDS}s must stay under the step's ${STEP_TIMEOUT_SECONDS}s timeout`);
  assert.ok(STEP_TIMEOUT_SECONDS - BUDGET_SECONDS >= 30,
    'too little headroom between the budget and the kill for the trailing writes');
});

test('the 429 backoff cannot outlive the budget it runs inside', () => {
  // One 429 slept 60s and a second 120s, against a 2-minute step. A backoff
  // longer than its own budget is a kill with extra steps.
  const h = SRC.slice(SRC.indexOf('async function httpGet('), SRC.indexOf('function sleep('));
  assert.ok(/budgetRemainingMs\(\)/.test(h), 'the retry does not consult the remaining budget');
  assert.ok(/outOfBudget/.test(h), 'the retry has no give-up branch');
});

test('main sets the deadline the retry reads', () => {
  assert.ok(/deadlineAt\s*=\s*startedAt \+ BUDGET_SECONDS \* 1000/.test(SRC),
    'the deadline is never armed, so budgetRemainingMs stays Infinity');
});

// ---------------------------------------------------------------------------
// Ordering: the XI is the only work with a deadline
// ---------------------------------------------------------------------------

test('lineups are asked for BEFORE predictions in the loop', () => {
  const body = SRC.slice(SRC.indexOf('for (let i = 0; i < matches.length; i++)'));
  const lineupAt = body.indexOf('fetchLineups(');
  const predAt   = body.indexOf('fetchPredictions(');
  assert.ok(lineupAt > -1 && predAt > -1);
  assert.ok(lineupAt < predAt,
    'the XI is the only call with a deadline; it must not queue behind a prediction');
});

test('predictions are throttled, not fetched every tick', () => {
  assert.ok(PREDICTION_REFRESH_HOURS >= 1,
    're-fetching 192 predictions a tick is what consumed the lineups budget');
});

// ---------------------------------------------------------------------------
// An empty table must say WHICH silence it is
// ---------------------------------------------------------------------------

test('the summary separates the four causes of an empty lineups table', () => {
  // Nothing near kickoff / already held / not published yet / ran out of
  // budget. Same principle as /api/inplay's `source` block: a silence that
  // does not say which is read as the feed going quiet.
  for (const k of ['lineupEmpty', 'lineupHeld', 'lineupOutOfWindow', 'stoppedOnBudget']) {
    assert.ok(SRC.includes(k), `census is missing ${k}`);
  }
  assert.ok(/not published yet/.test(SRC));
  assert.ok(/STOPPED ON BUDGET/.test(SRC));
});

test('a failed freshness read re-asks rather than skipping', () => {
  // Degrading to "we already have everything" would be silent and permanent.
  assert.ok(/will re-ask/.test(SRC));
});

// ---------------------------------------------------------------------------
// A PostgREST filter is a URL
// ---------------------------------------------------------------------------

test('id lists are chunked', () => {
  assert.ok(ID_CHUNK > 0 && ID_CHUNK <= 100,
    'eve-engine has taken silent multi-day outages from oversized .in() lists');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 60), []);
});

test('recently-completed still gets its stats window', () => {
  assert.equal(isRecentlyCompleted({ status: 'completed', kickoff_at: at(-60) }), true);
  assert.equal(isRecentlyCompleted({ status: 'completed', kickoff_at: at(-60 * 12) }), false);
  assert.equal(isRecentlyCompleted({ status: 'scheduled', kickoff_at: at(-60) }), false);
});
