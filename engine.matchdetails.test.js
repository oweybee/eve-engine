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
  isUpcoming, isRecentlyCompleted, chunk,
  PAST_GRACE_HOURS, AHEAD_HOURS,
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

test('lineups moved OUT of this script and are still called as a backstop', () => {
  // fetchLineups.js owns them on a 5-minute cron — the XI is the one thing
  // here that expires. This file keeps a backstop so a run of dropped ticks is
  // still covered, and it must go through the SAME module, never a second copy.
  assert.ok(/require\('\.\/lib\/lineupCapture'\)/.test(SRC), 'no shared module');
  assert.ok(/captureLineups\(/.test(SRC), 'the backstop is gone');
  const loop = SRC.slice(SRC.indexOf('for (let i = 0; i < matches.length; i++)'),
                         SRC.indexOf('const totalCalls'));
  assert.ok(!/fetchLineups\(/.test(loop.slice(0, loop.indexOf('} else if (isRecentlyCompleted'))),
    'the per-fixture loop must not fetch lineups; the module does that after it');
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

test('predictions are throttled, not fetched every tick', () => {
  assert.ok(PREDICTION_REFRESH_HOURS >= 1,
    're-fetching 192 predictions a tick is what consumed the lineups budget');
});

// ---------------------------------------------------------------------------
// An empty table must say WHICH silence it is
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The league label — traced 22 Aug 2026 after "Hull City v Manchester United"
// was queried as a Premier League fixture.
//
// THE LABEL WAS CORRECT. Fixtures are fetched per league via
// `/fixtures?league=<apiId>`, so the competition is the QUERY PARAMETER and not
// a name match; `fetchFixturesForDate` additionally self-verifies the API's own
// league name against ours. Measured on production, 2026/27: the English
// pyramid holds 20 clubs x 38 fixtures with NO club in two leagues (every
// duplicate is `X + League Cup`). Hull City, Coventry and Sunderland really are
// promoted in this dataset.
//
// What the trace DID find is below.
// ---------------------------------------------------------------------------

const PLAN_SRC = fs.readFileSync(require.resolve('./planDay.js'), 'utf8');

test('AN UNTAGGED FIXTURE IS NEVER FILED AS THE PREMIER LEAGUE', () => {
  // An absent tag used to fall back to the first tracked league — [39,
  // 'Premier League', 'England'] — so a fixture that lost its tag became a
  // Premier League match, silently, in the one competition where nobody would
  // question it. The ratchet greps the SOURCE, so keep the banned expression
  // out of prose here too: this test failed on its own explanatory comment.
  assert.ok(!/_league \?\? TRACKED_LEAGUES\[0\]/.test(PLAN_SRC),
    'the fail-open default is back');
  assert.ok(/would otherwise have been filed as English Premier League/.test(PLAN_SRC),
    'skipped fixtures must be reported, not dropped silently');
});

test('the league id self-verify stays', () => {
  // A re-pointed or mistyped id would ingest the wrong competition silently.
  assert.ok(/LEAGUE ID MISMATCH/.test(PLAN_SRC));
  assert.ok(/league=\$\{league\.id\}/.test(PLAN_SRC),
    'the competition must come from the query parameter, never a name match');
});
