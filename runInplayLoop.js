'use strict';

/**
 * runInplayLoop.js — the in-play pipeline on its own clock.
 *
 * THE CRON WAS NEVER THE CADENCE. run-inplay.yml declares `2-59/5` — twelve
 * ticks an hour — and GitHub does not deliver it. Measured over 26 Aug 2026,
 * consecutive scheduled runs of that workflow:
 *
 *     04:04 04:51 05:19 05:53 06:29 07:26 08:07 08:57 09:41 10:16 10:53
 *     11:18 11:49 12:19 13:27 14:10 15:50 16:38 18:20
 *
 * Gaps of 25 to 102 minutes against a declared 5 — about 1.3 ticks an hour,
 * a tenth of what the cron asks for. fetchLineups.js already recorded the same
 * thing ("a MEDIAN GAP OF 34 MINUTES, minimum 17, never once 15") and this
 * file is that fix applied to the loop where cadence IS the product.
 *
 * WHAT IT COST, ON ONE MATCH. Rapid Vienna v Heart Of Midlothian kicked off
 * 16:45 on 26 Aug and ran to ~18:25. Exactly ONE tick landed inside it — 18:20,
 * at the 76th minute of 90 — so `odds` holds a single post-kickoff row and
 * `inplay_market_series` a single capture. The engine looked at a 90-minute
 * match once, with 14 minutes left. Nothing was broken; the schedule simply
 * never came round.
 *
 * SO THE JOB POLLS ITSELF. One GitHub tick keeps this process alive for
 * LOOP_MINUTES, running a pass every PASS_INTERVAL_SECONDS. The cron's only
 * duty is to make sure a process is running at all — exactly the arrangement
 * lineups.yml uses, and for the same reason.
 *
 * LOOP_MINUTES MUST EXCEED THE DELIVERED GAP. That is the whole trick: a fresh
 * tick lands while a loop is still running, GitHub holds it as the single
 * pending run and starts it the instant this one ends, so coverage closes up
 * instead of gapping. Raise this, not the cron, if holes reappear.
 *
 * 50 WAS NOT ENOUGH, AND THE HOLE IT LEFT WAS MEASURED THE SAME EVENING. The
 * delivered gaps are not distributed around the median — the tail lands in the
 * evening, when the fixtures are. The last four scheduled runs of 26 Aug were
 * 100, 102 and 113 minutes apart, so the 19:00 kickoffs got their first tick at
 * 20:14 and seven matches carry that timestamp to the millisecond. It reads 170
 * in the workflow now, which exceeds the worst gap observed with margin; the
 * cost is deploy latency, and run-inplay.yml states it.
 *
 * IT SPAWNS THE EXISTING SCRIPTS UNCHANGED, as child processes, rather than
 * requiring them in-process. Each one owns its own Supabase client, its own
 * budget guard and its own exit code, and one of them dying must not take the
 * loop with it — a crash in the odds-api step has to leave the price and the
 * clock still being captured. Nothing about what any of them writes changes.
 *
 *   node runInplayLoop.js            poll for LOOP_MINUTES
 *   node runInplayLoop.js --once     one pass and exit (the old behaviour)
 *   node runInplayLoop.js --dry-run  print the plan, spawn nothing
 */

const { spawn } = require('child_process');
const { getClient } = require('./lib/supabaseClient');
const { LIVE_WINDOW_MS } = require('./lib/inplay');
const { beginWatchdog } = require('./lib/watchdog');

const ONCE = process.argv.includes('--once');
const DRY  = process.argv.includes('--dry-run');

/** See the header — must exceed the gap GitHub actually delivers. */
const LOOP_MINUTES = parseFloat(process.env.INPLAY_LOOP_MINUTES || '50');

/** The real cadence. In-play edges close in minutes; this is what decides. */
const PASS_INTERVAL_SECONDS = parseFloat(process.env.INPLAY_PASS_INTERVAL_SECONDS || '60');

/**
 * The Odds API step is metered and the others are not, so it gets its own,
 * slower clock. At a 60-second core cadence it would otherwise fire ~50x per
 * GitHub tick where it used to fire once; its own budget guard would throttle
 * that, but spending the guard is not the same as not needing it. The live
 * price and the clock come from API-Football, which is what has to be fast.
 */
const ODDS_API_INTERVAL_SECONDS = parseFloat(process.env.INPLAY_ODDS_API_INTERVAL_SECONDS || '600');

/** Per-script wall clock. A hung child must not eat the pass it is inside. */
const STEP_TIMEOUT_SECONDS = parseFloat(process.env.INPLAY_STEP_TIMEOUT_SECONDS || '180');

/**
 * The pipeline, in order. `metered` marks the step on the slower clock.
 *
 * ORDER IS LOAD-BEARING and is the workflow's own: the price and match state
 * are ingested first, values computed against them, and only then is the chart
 * captured and anything posted. captureInplaySeries reading before
 * computeInplayValues would chart a tick the signals had not seen.
 */
const STEPS = [
  { name: 'live odds + match state', cmd: 'ingestLiveOdds.js' },
  { name: 'compute in-play values',  cmd: 'computeInplayValues.js' },
  { name: 'odds api (multi-book)',   cmd: 'ingestOddsApi.js', args: ['--inplay'], metered: true },
  { name: 'live match statistics',   cmd: 'fetchLiveStats.js' },
  { name: 'in-play market series',   cmd: 'captureInplaySeries.js' },
  { name: 'post in-play signals',    cmd: 'postToX.js' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Is anything actually in play? One indexed count, so a quiet hour costs one
 * query per pass instead of six node processes — measured on this repo, 47% of
 * all hours have no fixture inside the live window at all.
 *
 * FAILS OPEN. A read error returns true and the pass runs: skipping the whole
 * pipeline because a count failed would turn a transient database blip into a
 * silent in-play outage, which is the shape this repo keeps paying for.
 */
async function anythingLive(supabase) {
  const now = Date.now();
  const from = new Date(now - LIVE_WINDOW_MS).toISOString();
  const to   = new Date(now).toISOString();
  const { count, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .in('status', ['scheduled', 'live'])
    .gte('kickoff_at', from)
    .lte('kickoff_at', to);
  if (error) { console.warn(`[loop] live check failed (running anyway): ${error.message}`); return true; }
  return (count ?? 0) > 0;
}

/**
 * Run one script to completion. Resolves with its exit code rather than
 * throwing, because a non-zero step must not end the loop: the whole point of
 * coming round again in a minute is that the next pass gets another go.
 */
function runStep(step) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [step.cmd, ...(step.args ?? [])], {
      stdio: 'inherit',
      env: process.env,
    });
    const killAt = setTimeout(() => {
      console.error(`[loop] ${step.name} exceeded ${STEP_TIMEOUT_SECONDS}s — killing it`);
      child.kill('SIGKILL');
    }, STEP_TIMEOUT_SECONDS * 1000);
    child.on('error', err => { clearTimeout(killAt); console.error(`[loop] ${step.name} failed to start: ${err.message}`); resolve(-1); });
    child.on('close', code => { clearTimeout(killAt); resolve(code ?? -1); });
  });
}

async function onePass(supabase, { meteredDue }) {
  const live = await anythingLive(supabase);
  if (!live) { console.log('[loop] nothing in the live window — skipping the pass'); return { skipped: true, failures: 0 }; }

  let failures = 0;
  for (const step of STEPS) {
    if (step.metered && !meteredDue) { console.log(`[loop] skip ${step.name} (metered, next in its own window)`); continue; }
    const code = await runStep(step);
    if (code !== 0) { failures++; console.error(`[loop] ${step.name} exited ${code} — continuing`); }
  }
  return { skipped: false, failures };
}

async function main(watchdog) {
  const started = Date.now();
  const loopUntil = ONCE ? 0 : started + LOOP_MINUTES * 60_000;

  console.log(`[loop] in-play loop — ${ONCE ? 'single pass' : `${LOOP_MINUTES}m, a pass every ${PASS_INTERVAL_SECONDS}s`}` +
              `, metered steps every ${ODDS_API_INTERVAL_SECONDS}s, step timeout ${STEP_TIMEOUT_SECONDS}s`);
  // Before the client, so --dry-run needs no credentials and can be run
  // anywhere to read back the plan.
  if (DRY) { console.log(`[loop] --dry-run: would run ${STEPS.map(s => s.cmd).join(' → ')}`); return; }
  const supabase = getClient();

  let pass = 0, skipped = 0, failures = 0, lastMetered = 0;
  for (;;) {
    pass++;
    const meteredDue = (Date.now() - lastMetered) >= ODDS_API_INTERVAL_SECONDS * 1000;
    watchdog?.stage(`pass ${pass}`);
    console.log(`[loop] pass ${pass} at ${new Date().toISOString()}${meteredDue ? ' (metered due)' : ''}`);
    const r = await onePass(supabase, { meteredDue });
    if (meteredDue && !r.skipped) lastMetered = Date.now();
    if (r.skipped) skipped++;
    failures += r.failures;

    if (ONCE) break;
    const nextAt = Date.now() + PASS_INTERVAL_SECONDS * 1000;
    // Stop BEFORE a pass that would overrun the loop's own budget rather than
    // starting one the step timeout would have to kill: being killed is not
    // the same as stopping, and a killed run prints no summary.
    if (nextAt >= loopUntil) break;
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  console.log(`[loop] ${pass} pass(es) over ${((Date.now() - started) / 60_000).toFixed(1)}m — ` +
              `${skipped} skipped (nothing live), ${failures} step failure(s)`);
}

if (require.main === module) {
  // SIGTERM and SIGINT are what a step timeout and a cancelled workflow send,
  // and they ARE catchable — so a killed loop says which pass it died in
  // rather than printing nothing. SIGKILL is not catchable by anyone; the
  // always() alert in the workflow is the backstop under that.
  const watchdog = beginWatchdog('inplay-loop', {
    onTerminate: ({ stage }) => console.error(`[loop] terminated during ${stage}`),
  });
  main(watchdog)
    .then(() => watchdog.finish())
    .catch(err => { watchdog.finish(); console.error('[loop] fatal:', err.message); process.exit(1); });
}

module.exports = { STEPS, LOOP_MINUTES, PASS_INTERVAL_SECONDS, ODDS_API_INTERVAL_SECONDS, anythingLive };
