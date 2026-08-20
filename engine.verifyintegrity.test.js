'use strict';

/**
 * engine.verifyintegrity.test.js — the smoke alarm must actually look.
 *
 * THIS FILE'S FAILURE MODE IS REPORTING HEALTH WHILE BLIND, and it has had that
 * bug twice. Once when the select named a column that does not exist, which
 * errored and silently disabled the whole signal check. And once — until
 * 20 Aug 2026 — because `.limit(2000)` reads like a deliberate ceiling but
 * PostgREST caps a response at 1,000 rows server-side and a larger client limit
 * does not raise it. Measured against production: 1,599 rows in the table,
 * 1,000 returned, and the run printed "OK — 1000 computed rows".
 *
 * Only 186 of those rows were live, so an arbitrary 1,000-row slice verified
 * roughly 116 of them and missed ~70 every cycle — a different ~70 each run,
 * because there was no `order` either.
 */

const test = require('node:test');
const assert = require('node:assert');
const { checkComputedValues, checkSignals, isLive } = require('./verifyIntegrity');

/** A supabase double that enforces PostgREST's real 1,000-row response cap. */
function cappedClient(rowsByTable, { cap = 1000 } = {}) {
  const build = (rows) => {
    const node = {
      eq: () => node,
      order: () => node,
      range: async (from, to) => ({
        data: rows.slice(from, from + Math.min(to - from + 1, cap)),
        error: null,
      }),
    };
    return node;
  };
  return { from: (t) => ({ select: () => build(rowsByTable[t] ?? []) }) };
}

/** A well-formed, violation-free computed_values row. */
const cvRow = (i, match) => ({
  id: `cv-${String(i).padStart(5, '0')}`,
  match_id: `match-${String(i).padStart(5, '0')}`,
  model_architecture: 'MARKET_ANCHORED',
  home_edge: 0.05, best_home_odds: 2.0, home_value: true,
  match,
});

const LIVE = { status: 'NS', kickoff_at: new Date(Date.now() + 3_600_000).toISOString() };
const DONE = { status: 'FT', kickoff_at: new Date(Date.now() - 86_400_000).toISOString() };

test('A TABLE LARGER THAN THE CAP IS READ IN FULL, not truncated to 1,000', () => {
  // 1,599 is the live figure. Under `.limit(2000)` this returned 1,000.
  const rows = Array.from({ length: 1599 }, (_, i) => cvRow(i, DONE));
  const violations = [];
  return checkComputedValues(cappedClient({ computed_values: rows }), violations)
    .then((r) => {
      assert.strictEqual(r.fetched, 1599, 'the read stopped at the server cap');
      assert.deepStrictEqual(violations, []);
    });
});

test('NO LIVE ROW IS MISSED BEHIND THE CAP', async () => {
  // The rows that matter sit PAST the first 1,000 — the arrangement that made
  // the truncation invisible, since everything returned looked fine.
  const rows = [
    ...Array.from({ length: 1200 }, (_, i) => cvRow(i, DONE)),
    { ...cvRow(9001, LIVE), home_edge: 0.9 },   // implausible edge, must be caught
  ];
  const violations = [];
  const r = await checkComputedValues(cappedClient({ computed_values: rows }), violations);
  assert.strictEqual(r.checked, 1, 'the only live row was never reached');
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0], /implausible \+edge/);
});

test('IT REPORTS WHAT IT CHECKED, not just what it fetched', async () => {
  // "OK — 1000 computed rows" read as a thousand rows verified. It was ~116.
  const rows = [
    ...Array.from({ length: 50 }, (_, i) => cvRow(i, DONE)),
    ...Array.from({ length: 7 }, (_, i) => cvRow(1000 + i, LIVE)),
  ];
  const r = await checkComputedValues(cappedClient({ computed_values: rows }), []);
  assert.strictEqual(r.fetched, 57);
  assert.strictEqual(r.checked, 7);
  assert.notStrictEqual(r.fetched, r.checked, 'the two counts must stay distinguishable');
});

test('a failed query becomes a violation rather than a silent zero', async () => {
  const exploding = {
    from: () => ({
      select: () => ({
        eq: function () { return this; },
        order: function () { return this; },
        range: async () => ({ data: null, error: { message: 'boom' } }),
      }),
    }),
  };
  const violations = [];
  const r = await checkComputedValues(exploding, violations);
  assert.deepStrictEqual(r, { fetched: 0, checked: 0 });
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0], /\[query\] computed_values/);

  const sigViolations = [];
  assert.strictEqual(await checkSignals(exploding, sigViolations), 0);
  assert.match(sigViolations[0], /\[query\] value_signals/);
});

test('pending signals are paged too, though they fit today', async () => {
  const rows = Array.from({ length: 1400 }, (_, i) => ({
    id: `sig-${String(i).padStart(5, '0')}`,
    market: 'h2h', outcome: 'home', detected_edge: 0.05, detected_odds: 2.0,
  }));
  assert.strictEqual(await checkSignals(cappedClient({ value_signals: rows }), []), 1400);
});

test('isLive FAILS OPEN on a row with no match join', () => {
  // No join is not evidence the fixture finished. Suppressing it would hide
  // exactly the rows whose provenance we cannot establish.
  assert.strictEqual(isLive(null), true);
  assert.strictEqual(isLive(undefined), true);
  assert.strictEqual(isLive({}), true);
});

test('isLive excludes completed and long-past fixtures', () => {
  for (const st of ['FT', 'FINISHED', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO', 'INT']) {
    assert.strictEqual(isLive({ status: st }), false, st);
  }
  assert.strictEqual(isLive({ status: 'NS', kickoff_at: new Date(Date.now() - 3 * 3600_000).toISOString() }), false);
  assert.strictEqual(isLive({ status: 'NS', kickoff_at: new Date(Date.now() + 3600_000).toISOString() }), true);
});
