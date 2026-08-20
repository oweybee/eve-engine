'use strict';

/**
 * engine.teamstats.test.js — the step that ran for two weeks and wrote nothing.
 *
 * `fetchTeamStats` resolved teams for EVERY scheduled match — 9,152 of them on
 * 20 Aug 2026, one HTTP call plus a 120ms sleep each — before any team work
 * began. The workflow kills it at the step timeout, so it never reached the
 * team loop: `team_statistics` had not been written since 6 Aug, while the
 * workflow comment claimed the step had been fixed to populate them.
 *
 * Only 242 of those 9,152 kick off inside three days. The run was spending its
 * whole budget on fixtures weeks away and dying before the ones a reader is
 * about to look at.
 *
 * BEING KILLED IS NOT STOPPING. `referee_stats` is written AFTER the team loop,
 * so a SIGKILL at the timeout discards the entire aggregate the run just spent
 * two minutes computing, and prints no summary — nothing records that it
 * happened. The script now holds its own budget, under the step's timeout.
 */

const test = require('node:test');
const assert = require('node:assert');
const { stalestFirst, HORIZON_DAYS, BUDGET_SECONDS } = require('./fetchTeamStats');

const now = Date.now();

test('THE SCRIPT STOPS ITSELF BEFORE THE STEP KILLS IT', () => {
  // The order of these two numbers is the whole guard. If the step timeout is
  // ever lowered to or below the budget, the referee aggregate is lost again.
  const STEP_TIMEOUT_SECONDS = 3 * 60;   // .github/workflows/engine.yml
  assert.ok(BUDGET_SECONDS < STEP_TIMEOUT_SECONDS,
    `budget ${BUDGET_SECONDS}s must stay under the step's ${STEP_TIMEOUT_SECONDS}s timeout`);
  // And with enough headroom that the final referee writes actually fit.
  assert.ok(STEP_TIMEOUT_SECONDS - BUDGET_SECONDS >= 30,
    'too little headroom between the budget and the kill for the trailing writes');
});

test('the horizon is bounded to days, not the whole scheduled slate', () => {
  assert.ok(HORIZON_DAYS > 0 && HORIZON_DAYS <= 14,
    'an unbounded horizon is what made this run over 9,152 fixtures');
});

test('A TEAM NEVER FETCHED GOES FIRST', () => {
  const teams = new Map([[1, 'a'], [2, 'b'], [3, 'c']]);
  const fresh = new Map([[1, now - 1000], [2, now - 99_999_999]]);
  assert.deepStrictEqual(stalestFirst(teams, fresh).map(e => e[0]), [3, 2, 1]);
});

test('STALEST FIRST — so a budget-stopped run covers the tail next time', () => {
  // A stable order would refresh the same head every cycle and starve the rest
  // forever, which looks exactly like the script working.
  const teams = new Map([[10, 'j'], [20, 'k'], [30, 'l'], [40, 'm']]);
  const fresh = new Map([[10, now - 1_000], [20, now - 5_000], [30, now - 2_000], [40, now - 9_000]]);
  assert.deepStrictEqual(stalestFirst(teams, fresh).map(e => e[0]), [40, 20, 30, 10]);
});

test('the ordering never drops or duplicates a team', () => {
  const teams = new Map(Array.from({ length: 50 }, (_, i) => [i, `t${i}`]));
  const fresh = new Map(Array.from({ length: 20 }, (_, i) => [i * 2, now - i * 1000]));
  const out = stalestFirst(teams, fresh);
  assert.strictEqual(out.length, 50);
  assert.strictEqual(new Set(out.map(e => e[0])).size, 50);
});

test('an empty team set orders to nothing rather than throwing', () => {
  assert.deepStrictEqual(stalestFirst(new Map(), new Map()), []);
});
