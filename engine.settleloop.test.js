'use strict';

// Settlement's cadence and its staleness alarm.
//
// THE OUTAGE THESE EXIST FOR. On 27 Aug 2026 engine.yml ran at 11:12 UTC and
// then not again until 21:02 — a ten-hour gap on a quarter-hour cron. Settlement
// was step 10 of that job, so 39 fixtures finished ungraded, `matches.status`
// stayed 'live', and `settle_match_signals()` refuses anything that is not
// 'completed'. Two winning PRIME picks were missing from /performance for three
// hours after full time.
//
// Nothing could see it. A schedule that never fires produces no run, therefore
// no failed run, therefore no annotation — and engine.yml's health step is
// `if: always()`, which only speaks about a run that happened. So there are two
// halves here: the loop that stops the cron deciding the cadence, and the
// backlog reading that makes a gap audible on the first run that does occur.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  pruneVolatileDates, reportBacklog,
  LOOP_MINUTES, PASS_INTERVAL_SECONDS, STALE_AFTER_MINUTES, BACKLOG_HORIZON_HOURS,
} = require('./fetchResults');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}
async function testAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

const WF = path.join(__dirname, '.github', 'workflows');
const read = f => fs.readFileSync(path.join(WF, f), 'utf8');
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// pruneVolatileDates — why one cache may be held across passes
// ---------------------------------------------------------------------------
console.log('\npruneVolatileDates');

const dayKey = ms => new Date(Date.now() - ms).toISOString().slice(0, 10);

test('keeps a date old enough that its results cannot change', () => {
  const cache = new Map([[dayKey(30 * 24 * HOUR), ['fixture']]]);
  assert.strictEqual(pruneVolatileDates(cache).size, 1);
});

test("evicts today's, because a match finishes mid-run and that is the point", () => {
  const cache = new Map([[dayKey(0), ['fixture']]]);
  assert.strictEqual(pruneVolatileDates(cache).size, 0);
});

test('evicts yesterday too — a late kickoff settles after midnight UTC', () => {
  const cache = new Map([[dayKey(24 * HOUR), ['fixture']]]);
  assert.strictEqual(pruneVolatileDates(cache).size, 0);
});

test('the 2022 dates that dominate the queue survive every pass', () => {
  // 78 rows across 45 distinct dates were in the settlement queue on 27 Aug,
  // 44 of them fixtures the feed has never returned as finished. Re-fetching
  // those every pass is what would make a tight cadence unaffordable.
  const old = Array.from({ length: 44 }, (_, i) => [dayKey((400 + i) * 24 * HOUR), []]);
  const cache = new Map([...old, [dayKey(0), []]]);
  assert.strictEqual(pruneVolatileDates(cache).size, 44);
});

// ---------------------------------------------------------------------------
// reportBacklog — an AGE alarm, never a count alarm
// ---------------------------------------------------------------------------
console.log('\nreportBacklog');

// Minimal PostgREST-shaped stub: every filter returns `this`, and awaiting the
// chain yields the next queued response. reportBacklog awaits two chains that
// terminate at different methods, so the object has to be thenable throughout.
function stubClient(responses) {
  let i = 0;
  const chain = {
    select: () => chain, eq: () => chain, lt: () => chain,
    gte: () => chain, order: () => chain, limit: () => chain,
    then: (resolve, reject) => Promise.resolve(responses[i++]).then(resolve, reject),
  };
  return { from: () => chain };
}

async function capture(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), out: lines.join('\n') }; }
  finally { console.log = real; }
}

const iso = ms => new Date(Date.now() - ms).toISOString();
// A signal becomes eligible at kickoff + 2h, so lateness is measured from there.
const eligibleFor = mins => iso(2 * HOUR + mins * 60_000);

(async () => {

await testAsync('alarms when the oldest settleable signal is past the limit', async () => {
  const { out, result } = await capture(() => reportBacklog(stubClient([
    { data: [{ kickoff_at: eligibleFor(STALE_AFTER_MINUTES + 120) }], count: 12, error: null },
    { count: 11, error: null },
  ])));
  assert.ok(/::error title=settlement is behind::/.test(out), 'expected an error annotation');
  assert.ok(result.overdueMin > STALE_AFTER_MINUTES);
});

await testAsync('is silent while settlement is keeping up', async () => {
  const { out } = await capture(() => reportBacklog(stubClient([
    { data: [{ kickoff_at: eligibleFor(4) }], count: 3, error: null },
    { count: 11, error: null },
  ])));
  assert.ok(!/::error/.test(out), 'a fixture eligible four minutes ago is the ordinary case');
});

await testAsync('is silent on an empty backlog', async () => {
  const { out, result } = await capture(() => reportBacklog(stubClient([
    { data: [], count: 0, error: null },
    { count: 11, error: null },
  ])));
  assert.ok(!/::error/.test(out));
  assert.strictEqual(result.overdueMin, 0);
});

await testAsync('the never-settling cohort is counted, never alarmed on', async () => {
  // The measured production state: 11 pending signals, none under a day old,
  // none on a completed match, oldest kickoff 8 Aug. A count alarm would read
  // 11 for ever, and an alarm that is always on is ignored within a week.
  const { out, result } = await capture(() => reportBacklog(stubClient([
    { data: [], count: 0, error: null },
    { count: 11, error: null },
  ])));
  assert.strictEqual(result.stale, 11);
  assert.ok(/11 older than that/.test(out), 'the cohort must still be reported');
  assert.ok(!/::error/.test(out), 'but it must not raise one');
});

await testAsync('a failed reading throws to its caller rather than being swallowed here', async () => {
  await assert.rejects(
    () => reportBacklog(stubClient([{ data: null, count: null, error: { message: 'boom' } }])),
    /boom/);
});

// ---------------------------------------------------------------------------
// Cadence — the ordering rule engine.yml learned the hard way on 6 Aug 2026
// ---------------------------------------------------------------------------
console.log('\ncadence');

test('the script stops itself before the step timeout kills it', () => {
  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(read('settle-results.yml'))[1]);
  assert.ok(LOOP_MINUTES < timeout,
    `loop ${LOOP_MINUTES}m must finish inside the step's ${timeout}m — being killed is not stopping`);
});

test('a pass interval that fits inside the loop', () => {
  assert.ok(PASS_INTERVAL_SECONDS <= LOOP_MINUTES * 60,
    'a loop that cannot complete one pass is a single-pass job wearing a loop');
});

test('the backlog horizon is longer than the alarm threshold', () => {
  assert.ok(BACKLOG_HORIZON_HOURS * 60 > STALE_AFTER_MINUTES,
    'a horizon shorter than the threshold hides the very rows the alarm is for');
});

// ---------------------------------------------------------------------------
// Where settlement runs, and where it must not
// ---------------------------------------------------------------------------
console.log('\nwiring');

test('settle-results.yml exists and is scheduled', () => {
  const yml = read('settle-results.yml');
  assert.ok(/schedule:/.test(yml) && /cron:/.test(yml));
  assert.ok(/node fetchResults\.js/.test(yml));
});

test('it never cancels a loop that is already running', () => {
  const yml = read('settle-results.yml');
  assert.ok(/concurrency:/.test(yml), 'without a group, ticks pile up and duplicate every API call');
  assert.ok(/cancel-in-progress:\s*false/.test(yml),
    'cancelling would kill a live 50-minute watch to start another on the same fixtures');
});

test('engine.yml does NOT settle — that is the whole change', () => {
  const yml = read('engine.yml');
  assert.ok(!/node fetchResults\.js/.test(yml),
    're-adding settlement to the engine tick puts it back behind a ~9-minute job ' +
    'and doubles the API-Football spend of every pass');
  assert.ok(!/steps\.results\.outcome/.test(yml),
    'the health report must not name a step that no longer exists');
});

test('the superseded run-engine.yml cannot start a 50-minute loop', () => {
  const yml = read('run-engine.yml');
  if (!/node fetchResults\.js/.test(yml)) return; // fine if it is ever removed
  assert.ok(/node fetchResults\.js --once/.test(yml),
    'that job sets no timeout-minutes, so an un-pinned call would hold a runner for the loop');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

})();
