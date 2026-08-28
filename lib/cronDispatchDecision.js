'use strict';

/**
 * Pure freshness/dispatch decision for scripts/gh-watchdog.
 *
 * Mirrors the same two-tier rule used for the manual health check: a flat
 * ceiling on how stale odds_snapshots may ever get, tightened once a fixture
 * is close enough to kickoff that the closing-line window is live. Kept
 * dependency-free and side-effect-free so it can be tested without touching
 * Supabase or the GitHub API — see engine.crondispatch.test.js.
 */
function evaluateFreshness({
  latestSnapshotAt,
  nextKickoffAt,
  now,
  staleMinutes,
  prekickoffWindowMinutes,
  prekickoffStaleMinutes,
}) {
  const gapMinutes = latestSnapshotAt
    ? (now.getTime() - latestSnapshotAt.getTime()) / 60000
    : Infinity;

  const minutesToKickoff = nextKickoffAt
    ? (nextKickoffAt.getTime() - now.getTime()) / 60000
    : null;

  const inPrekickoffWindow =
    minutesToKickoff !== null && minutesToKickoff >= 0 && minutesToKickoff <= prekickoffWindowMinutes;

  const flatBreach = gapMinutes > staleMinutes;
  const prekickoffBreach = inPrekickoffWindow && gapMinutes > prekickoffStaleMinutes;

  return {
    gapMinutes,
    minutesToKickoff,
    inPrekickoffWindow,
    flatBreach,
    prekickoffBreach,
    stale: flatBreach || prekickoffBreach,
  };
}

module.exports = { evaluateFreshness };
