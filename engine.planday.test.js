'use strict';

/**
 * engine.planday.test.js — THE PLANNER MUST NOT REPORT A REFUSAL AS A REST DAY.
 *
 * The outage of 1-7 October 2026, in one line: API-Football answers a quota,
 * plan or account failure with HTTP **200**, an `errors` object and an empty
 * `response` array. The account was suspended and returning
 *
 *     HTTP 200 {"errors":{"access":"Your account is suspended, check on …"}}
 *
 * `fetchFixturesForDate` read `json.response ?? []`, so that was indistinguishable
 * from a Tuesday with no football. `calcPlan` took its zero-fixture branch, wrote
 * a valid-looking EMPTY plan and exited 0. `ingestOdds` read the plan, logged
 * "rest day — no fixtures scheduled", and returned. Seven days of green runs.
 *
 * Two separate faults, so two separate guards and two separate sets of tests:
 *
 *   1. AN API REFUSAL IS FATAL. Checked once, on the only path every call takes,
 *      and never retried as though it were a rate limit.
 *   2. AN EMPTY ROW IS NOT A PLAN. The placeholder written at 00:04 made the
 *      outage self-locking: every later tick that day found a row and skipped,
 *      so fixing the upstream cause changed nothing until the next midnight.
 *
 * The first set are real unit tests. The second are source guards, in the style
 * of engine.phase0.test.js, because the behaviour lives inside `main()` behind a
 * Supabase client and the guard is the thing worth pinning, not the plumbing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { assertNoApiErrors } = require('./planDay');

// ── 1. the refusal guard ─────────────────────────────────────────────────────

test('a clean response passes, in all three shapes the API uses', () => {
  for (const errs of [undefined, null, [], {}]) {
    assert.doesNotThrow(() => assertNoApiErrors('/fixtures', { errors: errs, response: [] }));
  }
  assert.doesNotThrow(() => assertNoApiErrors('/fixtures', {}));
});

test('the real suspension payload throws, and is flagged as an API error', () => {
  const json = {
    errors: { access: 'Your account is suspended, check on https://dashboard.api-football.com.' },
    results: 0,
    response: [],
  };
  assert.throws(() => assertNoApiErrors('/fixtures?date=2026-10-07&league=39', json), (err) => {
    assert.strictEqual(err.isApiError, true);
    // The path and the payload both have to survive into the message: the whole
    // point is that the next reader does not have to guess which call refused.
    assert.match(err.message, /\/fixtures\?date=2026-10-07&league=39/);
    assert.match(err.message, /suspended/);
    return true;
  });
});

test('other refusal shapes throw too — quota, plan, token', () => {
  for (const errs of [
    { requests: 'You have reached the request limit for the day' },
    { plan: 'Your plan does not allow you to access this endpoint' },
    { token: 'Error/Missing application key' },
  ]) {
    assert.throws(() => assertNoApiErrors('/odds', { errors: errs, response: [] }),
                  (e) => e.isApiError === true);
  }
});

test('an EMPTY response with no errors is still a legitimate quiet day', () => {
  // This is the case the guard must NOT swallow. A real rest day returns 200,
  // no errors, and nothing — and the planner is allowed to write an empty plan
  // for it. Conflating the two in either direction is the bug.
  assert.doesNotThrow(() => assertNoApiErrors('/fixtures', { errors: [], results: 0, response: [] }));
});

// ── 2. the source guards ─────────────────────────────────────────────────────

const src = fs.readFileSync('./planDay.js', 'utf8');

test('httpGet checks the errors field on every call', () => {
  assert.match(src, /const json = await httpGetOnce\(path\);\s*\n\s*assertNoApiErrors\(path, json\);/,
    'assertNoApiErrors must sit on the single path every call takes');
});

test('an API refusal is never retried as though it were a rate limit', () => {
  const start = src.indexOf('async function httpGet(');
  const retry = src.slice(start, src.indexOf('async function fetchFixturesForDate', start));
  assert.ok(retry.indexOf('err.isApiError) throw err') < retry.indexOf('err.is429'),
    'the isApiError bail must come BEFORE the 429 backoff, or a refusal costs three minutes');
});

test('the early exit requires FIXTURES, not merely a row', () => {
  assert.match(src, /existingCount\s*=\s*existing\?\.fixture_ids\?\.length\s*\?\?\s*0/);
  assert.match(src, /if \(existing && existingCount > 0\)/,
    'a row with zero fixtures must be rebuilt over, not skipped');
});

test('a failed fetch exits before savePlan is ever reached', () => {
  const fail = src.indexOf('failed to fetch fixtures');
  const save = src.indexOf('await savePlan(');
  assert.ok(fail > -1 && save > -1 && fail < save);
  const between = src.slice(fail, save);
  assert.match(between, /process\.exit\(1\)/,
    'the fetch failure path must exit, so a refused day leaves the existing plan alone');
});

test('THESE TESTS CAN ACTUALLY FAIL', () => {
  assert.throws(() => assertNoApiErrors('/x', { errors: { any: 'thing' } }));
});
