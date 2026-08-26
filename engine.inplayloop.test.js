'use strict';

/**
 * engine.inplayloop.test.js — the in-play loop's shape and its guards.
 *
 * The cron asked for twelve ticks an hour and GitHub delivered ~1.3, so on
 * 26 Aug a 90-minute match got ONE look, at the 76th minute. These pin the
 * arrangement that fixes it — and pin the two settings that make it work,
 * because both are the kind that look arbitrary and are not.
 *
 * Run: node engine.inplayloop.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const loop = require('./runInplayLoop');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}
/**
 * Async cases need their OWN runner. Passing an async fn to `test` above
 * resolves the promise it returns and prints a tick immediately, so the
 * assertion inside lands after the summary and a failure surfaces as an
 * unhandled rejection rather than a red test — which is a ratchet that cannot
 * fail. Written the wrong way first, and caught by checking.
 */
async function testAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const wf = fs.readFileSync(path.join(__dirname, '.github/workflows/run-inplay.yml'), 'utf8');
const yamlNum = key => {
  const m = wf.match(new RegExp(`${key}:\\s*'?(\\d+(?:\\.\\d+)?)'?`));
  return m ? parseFloat(m[1]) : null;
};

console.log('the pipeline the loop runs');
test('every script the workflow used to run as its own step is still run', () => {
  const cmds = loop.STEPS.map(s => s.cmd);
  for (const f of ['ingestLiveOdds.js', 'computeInplayValues.js', 'ingestOddsApi.js',
                   'fetchLiveStats.js', 'captureInplaySeries.js', 'postToX.js']) {
    assert.ok(cmds.includes(f), `${f} dropped out of the loop`);
  }
});
test('and every one of them exists on disk', () => {
  for (const s of loop.STEPS) {
    assert.ok(fs.existsSync(path.join(__dirname, s.cmd)), `${s.cmd} is missing`);
  }
});
test('ORDER is the workflow\'s: price and state before values, values before the chart', () => {
  const at = f => loop.STEPS.findIndex(s => s.cmd === f);
  assert.ok(at('ingestLiveOdds.js') < at('computeInplayValues.js'),
    'values must be computed against a price that has just been ingested');
  assert.ok(at('computeInplayValues.js') < at('captureInplaySeries.js'),
    'the chart must not record a tick the signals never saw');
  assert.ok(at('computeInplayValues.js') < at('postToX.js'),
    'nothing can be posted before it is computed');
});
test('only the metered step is on the slower clock', () => {
  const metered = loop.STEPS.filter(s => s.metered).map(s => s.cmd);
  assert.deepStrictEqual(metered, ['ingestOddsApi.js'],
    'The Odds API is the only step that costs credits per call');
});

console.log('the two settings that are not arbitrary');
test('LOOP_MINUTES EXCEEDS the gap GitHub actually delivers', () => {
  // Measured 26 Aug 2026 on run-inplay.yml: gaps of 25-102 minutes, median
  // ~35, against a declared 5. A loop shorter than the delivered gap leaves a
  // systematic hole and the schedule is still deciding coverage.
  assert.ok(loop.LOOP_MINUTES >= 40,
    `LOOP_MINUTES ${loop.LOOP_MINUTES} must exceed the ~35m median delivered gap`);
});
test('the workflow timeout EXCEEDS LOOP_MINUTES — being killed is not stopping', () => {
  const timeout = yamlNum('timeout-minutes');
  const declared = yamlNum('INPLAY_LOOP_MINUTES');
  assert.ok(timeout != null && declared != null, 'both must be stated in the workflow');
  assert.ok(timeout > declared,
    `timeout-minutes ${timeout} must exceed INPLAY_LOOP_MINUTES ${declared}: a killed run prints no summary`);
});
test('the pass interval is the real cadence, and it is minutes not hours', () => {
  assert.ok(loop.PASS_INTERVAL_SECONDS <= 300,
    'in-play edges close in minutes; this is what decides coverage');
  assert.ok(loop.ODDS_API_INTERVAL_SECONDS > loop.PASS_INTERVAL_SECONDS,
    'the metered step must be slower than the core loop, not equal to it');
});

console.log('the workflow');
test('it runs the loop, not the six separate steps', () => {
  assert.ok(/node runInplayLoop\.js/.test(wf), 'the loop must be the step');
  assert.ok(!/^\s+run: node ingestLiveOdds\.js\s*$/m.test(wf),
    'the old per-step invocations must be gone, or both run and double-spend');
});
test('health is reported on ALWAYS, because a killed job is cancelled not failed', () => {
  assert.ok(/if:\s*always\(\)/.test(wf),
    "`if: failure()` does not fire on a cancelled job — engine.yml already paid for this");
});
test('concurrency does NOT cancel a running loop', () => {
  assert.ok(/cancel-in-progress:\s*false/.test(wf),
    'a fresh tick must queue behind the running loop, which is what closes the gap');
});

const countStub = (count, error = null) => ({ from: () => ({ select: () => ({ in: () => ({
  gte: () => ({ lte: async () => ({ count, error }) }) }) }) }) });

(async () => {
  console.log('anythingLive — the gate');
  await testAsync('a failed count runs the pass anyway (fails OPEN)', async () => {
    assert.strictEqual(await loop.anythingLive(countStub(null, { message: 'boom' })), true,
      'a database blip must not become a silent in-play outage');
  });
  await testAsync('zero live fixtures skips the pass', async () => {
    assert.strictEqual(await loop.anythingLive(countStub(0)), false);
  });
  await testAsync('one live fixture runs it', async () => {
    assert.strictEqual(await loop.anythingLive(countStub(1)), true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
