'use strict';

/**
 * lib/watchdog — turn a step that was KILLED into a step that SAID SO.
 *
 * THE FAILURE THIS EXISTS FOR, three times over in this repo's history:
 *
 *   - `fetchTeamStats` resolved 9,152 fixtures before any team work began, was
 *     killed at its step timeout on every run, and `team_statistics` went
 *     unwritten from 6 to 20 Aug 2026. The run list said "success".
 *   - `captureIndependentLines` ran as step 6 of a job whose step 5 spent nine
 *     of a shared fifteen minutes, and was killed with its table still three
 *     days stale. Reported as a timeout, not as a benchmark never written.
 *   - The engine job itself died between 610s and 633s on six consecutive runs
 *     against `timeout-minutes: 10`, mid `fetchMatchDetails`. That reads as
 *     'cancelled' in the run list, which sends you to the concurrency knob.
 *
 * Every one of them is the same shape: **being killed is not stopping.** A
 * script that stops itself prints a summary; a script that is killed prints
 * nothing, and nothing is indistinguishable from a quiet slate.
 *
 * WHAT THIS CAN AND CANNOT CATCH, stated plainly because the difference is the
 * whole design:
 *
 *   SIGTERM / SIGINT   CATCHABLE. This is what a GitHub Actions step timeout
 *                      and a `timeout(1)` send, and what a cancelled workflow
 *                      sends the process group. The handler below runs.
 *   SIGKILL            NOT CATCHABLE, by anyone, ever. No handler runs and no
 *                      line is printed. GitHub sends it ~10s after SIGTERM if
 *                      the process has not gone, and the OOM killer sends it
 *                      cold. The mitigation for SIGKILL is at the WORKFLOW
 *                      level — the `if: always()` alert in engine.yml, which
 *                      fires on a cancelled job as well as a failed one — and
 *                      not here.
 *
 * So this closes the common case and names the one it cannot close, rather
 * than implying a guarantee it does not have.
 *
 * The self-budget in a script (`BUDGET_SECONDS` in fetchTeamStats) is still the
 * primary mechanism and is unchanged: **the script must stop itself before the
 * step kills it.** This is the backstop under that, for the runs where the
 * budget was set wrong or the work outgrew it.
 */

/** Exit code a process gets from an uncaught SIGTERM (128 + 15). Kept so a
 *  killed step is distinguishable from an ordinary failure in the run log. */
const SIGTERM_EXIT = 143;

/**
 * Arm the watchdog for a script.
 *
 * @param {string} name  what to call this step in the alert — the SCRIPT, not
 *                       the workflow step, because the reader's next move is to
 *                       open that file.
 * @param {{ onTerminate?: (info: {stage: string, elapsedMs: number}) => void }} [opts]
 *                       an optional last-gasp reporter. Keep it SYNCHRONOUS and
 *                       cheap: the process is being torn down and an await here
 *                       is a promise nobody will resolve. Printing a partial
 *                       census is the intended use; a database write is not.
 * @returns {{ stage: (s: string) => void, finish: () => void }}
 */
function beginWatchdog(name, opts = {}) {
  const startedAt = Date.now();
  let current = 'starting';
  let armed = true;

  const report = (signal) => {
    if (!armed) return;
    armed = false;
    const elapsedMs = Date.now() - startedAt;
    const secs = (elapsedMs / 1000).toFixed(1);

    // TWO LINES ON PURPOSE. The `::error::` is a GitHub Actions annotation and
    // surfaces on the run summary where somebody scanning the list will see it;
    // the plain line survives `tee`, a local run and a log grep, which the
    // annotation does not.
    const msg = `${name} TERMINATED by ${signal} after ${secs}s at stage "${current}" `
      + '— it did not finish and it did not stop itself; whatever this step writes '
      + 'is PARTIAL or ABSENT. Raise the step budget or narrow the work.';
    console.error(`::error title=${name} killed::${msg}`);
    console.error(`[watchdog] ${msg}`);

    if (typeof opts.onTerminate === 'function') {
      // A reporter that throws must not swallow the message above it — the
      // whole point of this handler is that SOMETHING is printed.
      try { opts.onTerminate({ stage: current, elapsedMs }); }
      catch (err) { console.error(`[watchdog] reporter failed: ${err.message}`); }
    }

    // Exit non-zero and with the signal's own code. Re-raising the signal would
    // be tidier, but the default handler is now removed and re-raising loops.
    process.exit(SIGTERM_EXIT);
  };

  const onTerm = () => report('SIGTERM');
  const onInt = () => report('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return {
    /** Name the phase the script is in, so the alert says WHERE it died. */
    stage(s) { current = String(s); },
    /** Ran to completion — disarm, so a signal during shutdown says nothing. */
    finish() {
      armed = false;
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
    },
  };
}

module.exports = { beginWatchdog, SIGTERM_EXIT };
