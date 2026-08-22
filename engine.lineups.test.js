'use strict';

/**
 * engine.lineups.test.js — the XI is the one thing here that expires.
 *
 * Reported live, 22 Aug 2026: a Premier League match page 25 minutes from
 * kickoff with no lineups. Measured over the whole table:
 *
 *     lineup rows ever written             1,362
 *     captured BEFORE kickoff                 26   (1.9%)
 *     mean lateness                      11.4 days
 *     earliest capture ever                   52 min before kickoff
 *
 * Cause: lineups were step 7 of a 9-minute pipeline behind a work list with no
 * lower bound on kickoff_at, so the budget went on fixtures from 2022. They
 * are their own job now, on a 5-minute cron, over this module.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  DEFAULTS, chunk, inLineupWindow, byKickoff, captureLineups, summarise,
} = require('./lib/lineupCapture');

const WF = fs.readFileSync('.github/workflows/lineups.yml', 'utf8');
const JOB = fs.readFileSync('./fetchLineups.js', 'utf8');
const at = mins => new Date(Date.now() + mins * 60_000).toISOString();
const sched = mins => ({ status: 'scheduled', kickoff_at: at(mins), external_id: '1', id: 'a' });

// ---------------------------------------------------------------------------
// The window has to OPEN before the notice it is meant to deliver
// ---------------------------------------------------------------------------

test('THE WINDOW OPENS BEFORE 60 MINUTES, or an hour of notice is impossible', () => {
  // To HOLD a lineup at T-60 we must have ASKED before T-60. A 60-minute
  // window can only ever deliver it late.
  assert.ok(DEFAULTS.windowMinutes > 60,
    `window ${DEFAULTS.windowMinutes}m cannot deliver an hour of notice`);
  // And not so early that every tick burns calls on an endpoint that returns
  // an empty array — the earliest availability ever observed is 52 minutes.
  assert.ok(DEFAULTS.windowMinutes <= 180);
});

test('inLineupWindow admits the imminent and refuses the distant', () => {
  assert.equal(inLineupWindow(sched(89)), true);
  assert.equal(inLineupWindow(sched(25)), true, 'the reported fixture');
  assert.equal(inLineupWindow(sched(60 * 47)), false, '47 hours out — no XI exists');
});

test('IT IS GATED ON THE CLOCK, NOT ON STATUS', () => {
  // Production has never written status='live' and a fixture sits at
  // 'scheduled' until fetchResults settles it, so a status-based test would
  // never open the window at all.
  assert.equal(inLineupWindow(sched(-20)), true, 'kicked off 20m ago, still scheduled');
  assert.equal(inLineupWindow({ status: 'live', kickoff_at: at(-10) }), true);
  assert.equal(inLineupWindow({ status: 'completed', kickoff_at: at(-20) }), false);
});

test('the grace is bounded — that is where the 11.4-day-late rows came from', () => {
  assert.ok(DEFAULTS.graceMinutes > 0 && DEFAULTS.graceMinutes <= 180);
  assert.equal(inLineupWindow(sched(-(DEFAULTS.graceMinutes + 10))), false,
    'a fixture from 2022 must never re-enter the work list');
});

test('a malformed or absent kickoff refuses rather than throwing', () => {
  assert.equal(inLineupWindow({ status: 'scheduled', kickoff_at: null }), false);
  assert.equal(inLineupWindow({ status: 'scheduled', kickoff_at: 'not a date' }), false);
  assert.equal(inLineupWindow({}), false);
  assert.equal(inLineupWindow(null), false);
});

test('soonest kickoff first — a missed XI is not late, it is gone', () => {
  const rows = [sched(80), sched(10), sched(45)].sort(byKickoff);
  const mins = rows.map(r => Math.round((new Date(r.kickoff_at) - Date.now()) / 60_000));
  assert.deepEqual(mins.map(m => m <= mins[mins.length - 1]), [true, true, true]);
  assert.ok(mins[0] < mins[1] && mins[1] < mins[2]);
});

// ---------------------------------------------------------------------------
// captureLineups, over a fake client
// ---------------------------------------------------------------------------

function fakeSupabase({ matches = [], held = [], onUpsert = () => {} } = {}) {
  return {
    from(table) {
      if (table === 'matches') {
        const q = { select: () => q, not: () => q, in: () => q, gte: () => q, lte: () => q,
                    order: () => q, limit: async () => ({ data: matches, error: null }) };
        return q;
      }
      if (table === 'lineups') {
        return {
          select: () => ({ in: () => ({ eq: async () => ({ data: held.map(f => ({ fixture_id: f })), error: null }) }) }),
          upsert: async (row) => { onUpsert(row); return { error: null }; },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const XI = n => ({ team: { id: n, name: `T${n}` }, startXI: [{ player: { id: 1, name: 'A' } }], substitutes: [] });

test('it captures a due fixture and records how much notice we got', async () => {
  const written = [];
  const sb = fakeSupabase({ matches: [sched(40)], onUpsert: r => written.push(r) });
  const c = await captureLineups(sb, async () => [XI(1), XI(2)], { pauseMs: 0 });
  assert.equal(c.fixtures, 1);
  assert.equal(c.rows, 2);
  assert.equal(written.length, 2);
  assert.equal(written[0].confirmed, true);
  assert.ok(c.leads[0] >= 38 && c.leads[0] <= 41, `lead ${c.leads[0]} should be ~40m`);
});

test('AN EMPTY RESPONSE IS "NOT PUBLISHED YET", NOT A FAILURE', async () => {
  // This is the ordinary state for most of the window and must not be recorded
  // as an error, or a normal tick looks broken.
  const sb = fakeSupabase({ matches: [sched(80)] });
  const c = await captureLineups(sb, async () => [], { pauseMs: 0 });
  assert.equal(c.notPublished, 1);
  assert.equal(c.errors, 0);
  assert.equal(c.fixtures, 0);
  assert.match(summarise(c), /not published yet/);
});

test('A CONFIRMED LINEUP IS NEVER RE-ASKED — that is what makes 5 minutes affordable', async () => {
  let calls = 0;
  const sb = fakeSupabase({ matches: [sched(30)], held: ['1'] });
  const c = await captureLineups(sb, async () => { calls++; return [XI(1)]; }, { pauseMs: 0 });
  assert.equal(calls, 0, 'asked for an XI we already hold');
  assert.equal(c.held, 1);
  assert.equal(c.due, 0);
});

test('one fixture erroring does not stop the rest of the slate', async () => {
  const sb = fakeSupabase({ matches: [sched(10), sched(20)] });
  let n = 0;
  const c = await captureLineups(sb, async () => {
    if (++n === 1) throw new Error('boom');
    return [XI(1)];
  }, { pauseMs: 0 });
  assert.equal(c.errors, 1);
  assert.equal(c.fixtures, 1, 'the second fixture still got captured');
});

test('the budget stops it, and the summary says how many it never reached', async () => {
  const sb = fakeSupabase({ matches: [sched(10), sched(20), sched(30)] });
  const c = await captureLineups(sb, async () => [XI(1)], { pauseMs: 0, deadlineAt: Date.now() - 1 });
  assert.equal(c.stoppedOnBudget, true);
  assert.equal(c.unreached, 3);
  assert.match(summarise(c), /STOPPED ON BUDGET/);
});

test('a fixture outside the window is never in the work list', async () => {
  const sb = fakeSupabase({ matches: [sched(60 * 30), sched(-(DEFAULTS.graceMinutes + 60))] });
  const c = await captureLineups(sb, async () => { throw new Error('should not be asked'); }, { pauseMs: 0 });
  assert.equal(c.inWindow, 0);
  assert.equal(c.calls, 0);
});

// ---------------------------------------------------------------------------
// The cadence IS the guarantee, so the workflow is part of the contract
// ---------------------------------------------------------------------------

test('THE JOB HAS ITS OWN SCHEDULE', () => {
  // A 15-minute pipeline cannot chase a 20-minute publication. If this ever
  // becomes a step of engine.yml again, the guarantee goes with it.
  assert.match(WF, /cron:\s*'\*\/5 \* \* \* \*'/, 'lost its own schedule');
  assert.match(WF, /node fetchLineups\.js/);
});

test('--once exists, so a pass is drivable without a 25-minute loop', () => {
  assert.match(JOB, /--once/);
});

test('THE JOB POLLS ITSELF, because the cron is not the cadence', () => {
  // Measured on this repo: engine.yml declares every 15 minutes and GitHub
  // delivered a MEDIAN GAP OF 34 MINUTES over 25 runs, minimum 17. A lineup
  // published 20 minutes out and sampled every half hour is a coin flip, so
  // the real cadence has to come from inside the process.
  const { LOOP_MINUTES, PASS_INTERVAL_SECONDS } = require('./fetchLineups');
  assert.ok(PASS_INTERVAL_SECONDS <= 600,
    `a pass every ${PASS_INTERVAL_SECONDS}s cannot chase a 20-minute publication`);
  assert.ok(LOOP_MINUTES * 60 >= PASS_INTERVAL_SECONDS * 2,
    'a loop shorter than two passes is not a loop');
});

test('the script still stops itself before the step kills it', () => {
  const stepTimeoutS = 30 * 60;                      // timeout-minutes: 30
  const { BUDGET_SECONDS, LOOP_MINUTES } = require('./fetchLineups');
  assert.match(WF, /timeout-minutes:\s*30\b/);
  assert.ok(LOOP_MINUTES * 60 < stepTimeoutS,
    `loop ${LOOP_MINUTES}m must end before the step's ${stepTimeoutS / 60}m timeout`);
  assert.ok(stepTimeoutS - LOOP_MINUTES * 60 >= 120,
    'too little headroom between the loop and the kill for a final pass to finish');
  assert.ok(BUDGET_SECONDS < LOOP_MINUTES * 60,
    'one pass must not be able to consume the whole loop');
});

test('the job deliberately outlives its schedule, and concurrency covers that', () => {
  // The old ordering (step < interval) is intentionally broken here. What
  // stops a pile-up is GitHub's one-pending-run-per-group rule, so
  // cancel-in-progress MUST stay false — cancelling would kill a live watch.
  assert.match(WF, /cancel-in-progress:\s*false/);
  assert.match(WF, /concurrency:/);
});

test('the 429 backoff is SHORT here, unlike the pipeline job', () => {
  // Sleeping 60s inside a 5-minute cadence spends the whole tick on the one
  // job whose value is that it comes round again soon.
  assert.match(JOB, /baseDelayMs = 5_000/);
});

test('--report measures the promise rather than restating it', () => {
  // "Do we have lineups an hour before kickoff?" is a question about the FEED,
  // and only measurement answers it.
  assert.match(JOB, /an hour before/);
  assert.match(JOB, />= 60 min before kickoff/);
});

test('id lists are chunked', () => {
  assert.ok(DEFAULTS.idChunk > 0 && DEFAULTS.idChunk <= 100,
    'eve-engine has taken silent multi-day outages from oversized .in() lists');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 60), []);
});
