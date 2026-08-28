'use strict';

/**
 * GitHub Actions schedule watchdog.
 *
 * engine.yml's own `schedule:` cron is delivered best-effort by GitHub and
 * has been observed dropping for 8-11+ hours under load — the same
 * throttling scripts/inplay-vps/README.md already documents for
 * run-inplay.yml ("useless for reacting to a goal"). 28 Aug 2026: the last
 * schedule-triggered engine.yml run completed 05:36 UTC; nothing fired again
 * until a manual dispatch ten and a half hours later, by which point
 * odds_snapshots was 112 minutes stale with a fixture 26 minutes from
 * kickoff. No run was stuck or queued — GitHub simply never delivered the
 * trigger.
 *
 * workflow_dispatch is a direct REST call, not a scheduled queue slot, so it
 * is not subject to that throttling. This script checks the same freshness
 * signal a human would (odds_snapshots vs the next kickoff) from a host
 * GitHub Actions does not control, and fires workflow_dispatch on the
 * configured workflow(s) when the native cron has evidently not.
 *
 * This can only do its job running somewhere OTHER than GitHub Actions —
 * putting the watchdog on its own GitHub Actions schedule would inherit the
 * exact failure it exists to catch. Run it on the always-on host that
 * already carries scripts/betfair-vps and/or scripts/inplay-vps; see
 * README.md for systemd setup.
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN
 *
 * Usage:
 *   node scripts/gh-watchdog/ghWatchdog.js             — check, dispatch if stale
 *   node scripts/gh-watchdog/ghWatchdog.js --dry-run    — check + log only
 */

const { getClient } = require('../../lib/supabaseClient');
const { evaluateFreshness } = require('../../lib/cronDispatchDecision');

const DRY_RUN = process.argv.includes('--dry-run');

const GITHUB_API = 'https://api.github.com';
const GITHUB_OWNER = process.env.WATCHDOG_GITHUB_OWNER || 'oweybee';
const GITHUB_REPO = process.env.WATCHDOG_GITHUB_REPO || 'eve-engine';
const GITHUB_REF = process.env.WATCHDOG_GITHUB_REF || 'main';

const WORKFLOWS = (process.env.WATCHDOG_WORKFLOWS || 'engine.yml')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Same two-tier rule as the manual health check this replaces: a flat
// ceiling, tightened once a fixture is close enough that the closing-line
// window matters. Checked on a ~10min interval (see the bundled systemd
// timer), so both bars have comfortable margin against the point a human
// would actually need paging.
const STALE_MINUTES = Number(process.env.WATCHDOG_STALE_MINUTES || 30);
const PREKICKOFF_WINDOW_MINUTES = Number(process.env.WATCHDOG_PREKICKOFF_WINDOW_MINUTES || 120);
const PREKICKOFF_STALE_MINUTES = Number(process.env.WATCHDOG_PREKICKOFF_STALE_MINUTES || 25);

function githubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing env var: GITHUB_TOKEN');
  return token;
}

async function githubRequest(path, opts = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  return res;
}

// Avoid piling on a run that is already queued or in progress — the
// pipeline's own concurrency group (cancel-in-progress: false) would just
// queue a duplicate behind it rather than skip it, which wastes Actions
// minutes and API-Football/Odds-API budget for nothing.
async function hasRunInFlight(workflowFile) {
  for (const status of ['queued', 'in_progress']) {
    const res = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowFile}/runs?status=${status}&per_page=1`
    );
    if (!res.ok) {
      console.warn(`[gh-watchdog] could not check ${status} runs for ${workflowFile}: HTTP ${res.status}`);
      continue;
    }
    const json = await res.json();
    if ((json.total_count || 0) > 0) return true;
  }
  return false;
}

async function dispatch(workflowFile) {
  if (DRY_RUN) {
    console.log(`[gh-watchdog] DRY RUN — would dispatch ${workflowFile}`);
    return;
  }
  const res = await githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
    { method: 'POST', body: JSON.stringify({ ref: GITHUB_REF }) }
  );
  if (res.status === 204) {
    console.log(`[gh-watchdog] dispatched ${workflowFile}`);
  } else {
    const body = await res.text().catch(() => '');
    console.error(`[gh-watchdog] dispatch failed for ${workflowFile}: HTTP ${res.status} ${body}`);
  }
}

async function main() {
  const supabase = getClient();

  const [{ data: snapRows, error: snapErr }, { data: matchRows, error: matchErr }] = await Promise.all([
    supabase.from('odds_snapshots').select('captured_at').order('captured_at', { ascending: false }).limit(1),
    supabase
      .from('matches')
      .select('kickoff_at')
      .eq('status', 'scheduled')
      .gt('kickoff_at', new Date().toISOString())
      .order('kickoff_at', { ascending: true })
      .limit(1),
  ]);

  if (snapErr) throw new Error(`odds_snapshots read failed: ${snapErr.message}`);
  if (matchErr) throw new Error(`matches read failed: ${matchErr.message}`);

  const latestSnapshotAt = snapRows && snapRows[0] ? new Date(snapRows[0].captured_at) : null;
  const nextKickoffAt = matchRows && matchRows[0] ? new Date(matchRows[0].kickoff_at) : null;
  const now = new Date();

  const result = evaluateFreshness({
    latestSnapshotAt,
    nextKickoffAt,
    now,
    staleMinutes: STALE_MINUTES,
    prekickoffWindowMinutes: PREKICKOFF_WINDOW_MINUTES,
    prekickoffStaleMinutes: PREKICKOFF_STALE_MINUTES,
  });

  const gapDesc = Number.isFinite(result.gapMinutes) ? `${result.gapMinutes.toFixed(1)}min` : 'never captured';
  const kickoffDesc = result.minutesToKickoff === null ? 'none upcoming' : `${result.minutesToKickoff.toFixed(1)}min`;
  console.log(`[gh-watchdog] odds_snapshots gap=${gapDesc} next_kickoff=${kickoffDesc} stale=${result.stale}`);

  if (!result.stale) return;

  console.warn(
    `[gh-watchdog] STALE (flatBreach=${result.flatBreach} prekickoffBreach=${result.prekickoffBreach}) — ` +
      `dispatching: ${WORKFLOWS.join(', ')}`
  );

  for (const workflowFile of WORKFLOWS) {
    const inFlight = await hasRunInFlight(workflowFile);
    if (inFlight) {
      console.log(`[gh-watchdog] ${workflowFile} already queued/in_progress — skipping dispatch`);
      continue;
    }
    await dispatch(workflowFile);
  }
}

main().catch((err) => {
  console.error(`[gh-watchdog] failed: ${err.message}`);
  process.exitCode = 1;
});
