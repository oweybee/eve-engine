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
const { checkComputedValues, checkSignals, checkMarketCoverage, isLive } = require('./verifyIntegrity');

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

// ---------------------------------------------------------------------------
// checkMarketCoverage — the smoke alarm for the "awaiting prices" failure:
// odds ingested but never priced. It must flag missing / stale / unpriced by
// SYMPTOM, ignore legitimately single-book fixtures, and page past the cap so
// it cannot itself be blinded by the truncation it watches for.
// ---------------------------------------------------------------------------

/** A supabase double covering both query shapes checkMarketCoverage issues:
 *  the matches read (.eq/.gt/.lt/.order/.limit) and the odds/computed_values
 *  reads (.in then .order/.range via lib/pagedRead), enforcing the 1,000-row cap. */
function coverageClient({ matches = [], odds = [], computed_values = [] }, { cap = 1000 } = {}) {
  const byTable = { matches, odds, computed_values };
  const node = (rows) => {
    const n = {
      eq: () => n, gt: () => n, lt: () => n, in: () => n, order: () => n,
      limit: async (k) => ({ data: rows.slice(0, k), error: null }),
      range: async (from, to) => ({
        data: rows.slice(from, from + Math.min(to - from + 1, cap)),
        error: null,
      }),
    };
    return n;
  };
  return { from: (t) => ({ select: () => node(byTable[t] ?? []) }) };
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const soon = () => new Date(Date.now() + 6 * 3600_000).toISOString();
const m = (id) => ({ id, external_id: id.toUpperCase(), status: 'scheduled', kickoff_at: soon() });
const h2h = (mid, book, msAgo = 0) => ({ id: `${mid}-${book}`, match_id: mid, market: 'h2h', bookmaker: book, fetched_at: iso(msAgo) });
const mkt = (mid, market, msAgo = 0) => ({ id: `${mid}-${market}`, match_id: mid, market, bookmaker: 'a', fetched_at: iso(msAgo) });

test('coverage flags missing, stale and unpriced — and counts what it checked', async () => {
  const matches = [m('h1'), m('m1'), m('s1'), m('u1'), m('k1')];
  const odds = [
    // h1 healthy: 2 h2h books + totals + btts, all fresh
    h2h('h1', 'a'), h2h('h1', 'b'), mkt('h1', 'totals'), mkt('h1', 'btts'),
    // m1 missing compute: 2 h2h books ingested
    h2h('m1', 'a'), h2h('m1', 'b'),
    // s1 stale compute: 2 h2h books, fresh odds
    h2h('s1', 'a'), h2h('s1', 'b'),
    // u1 unpriced totals: 2 h2h books + totals ingested
    h2h('u1', 'a'), h2h('u1', 'b'), mkt('u1', 'totals'),
    // k1 single-book: only one h2h book → below MIN_BOOKMAKERS, must be skipped
    h2h('k1', 'a'),
  ];
  const computed_values = [
    { id: 'cv-h1', match_id: 'h1', computed_at: iso(10 * 60_000), best_home_odds: 2.0, over_odds: 1.9, btts_yes_odds: 1.8 },
    { id: 'cv-s1', match_id: 's1', computed_at: iso(120 * 60_000), best_home_odds: 2.0, over_odds: 1.9, btts_yes_odds: 1.8 },
    { id: 'cv-u1', match_id: 'u1', computed_at: iso(5 * 60_000), best_home_odds: 2.0, over_odds: null, btts_yes_odds: null },
  ];
  const violations = [];
  const checked = await checkMarketCoverage(coverageClient({ matches, odds, computed_values }), violations);

  assert.strictEqual(checked, 4, 'k1 (single-book) is skipped; the other four are checked');
  assert.strictEqual(violations.length, 3, 'exactly missing + stale + unpriced');
  assert.ok(violations.some(v => /coverage M1: .*NO computed_values row/.test(v)), 'missing compute flagged');
  assert.ok(violations.some(v => /coverage S1: computed_values stale/.test(v)), 'stale compute flagged');
  assert.ok(violations.some(v => /coverage U1: totals odds ingested but over\/under not priced/.test(v)), 'unpriced totals flagged');
  assert.ok(!violations.some(v => /K1/.test(v)), 'single-book fixture raises nothing');
});

test('coverage stays silent when every priced market is current', async () => {
  const matches = [m('ok1')];
  const odds = [h2h('ok1', 'a'), h2h('ok1', 'b'), mkt('ok1', 'totals'), mkt('ok1', 'btts')];
  const computed_values = [{
    id: 'cv-ok1', match_id: 'ok1', computed_at: iso(3 * 60_000),
    best_home_odds: 2.0, over_odds: 1.9, btts_yes_odds: 1.8,
  }];
  const violations = [];
  const checked = await checkMarketCoverage(coverageClient({ matches, odds, computed_values }), violations);
  assert.strictEqual(checked, 1);
  assert.deepStrictEqual(violations, []);
});

test('coverage cannot be blinded by the 1,000-row cap', async () => {
  // The row proving the second h2h book, and the totals row, sit PAST the cap —
  // the exact arrangement that made truncation invisible. Paged reads must see
  // them, so this healthy match neither drops below MIN_BOOKMAKERS nor
  // false-alarms on unpriced totals.
  const filler = Array.from({ length: 1000 }, (_, i) => h2h('zzz', `book-${i}`));
  const matches = [m('big')];
  const odds = [
    h2h('big', 'a'),
    ...filler,               // 1,000 rows for another match, filling the first page
    h2h('big', 'b'),         // second book for `big` — only reachable on page 2
    mkt('big', 'totals'),    // totals for `big` — also on page 2
  ];
  const computed_values = [{
    id: 'cv-big', match_id: 'big', computed_at: iso(2 * 60_000),
    best_home_odds: 2.0, over_odds: 1.9, btts_yes_odds: null,
  }];
  const violations = [];
  const checked = await checkMarketCoverage(coverageClient({ matches, odds, computed_values }), violations);
  assert.strictEqual(checked, 1, 'both h2h books were seen despite the cap');
  assert.deepStrictEqual(violations, [], 'totals row past the cap was seen, so no false unpriced alarm');
});

test('a failed coverage query becomes a violation, not a silent zero', async () => {
  const boom = {
    from: () => ({
      select: () => ({
        eq: function () { return this; }, gt: function () { return this; }, lt: function () { return this; },
        in: function () { return this; }, order: function () { return this; },
        limit: async () => ({ data: null, error: { message: 'matches boom' } }),
        range: async () => ({ data: null, error: { message: 'matches boom' } }),
      }),
    }),
  };
  const violations = [];
  const checked = await checkMarketCoverage(boom, violations);
  assert.strictEqual(checked, 0);
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0], /\[query\] coverage matches/);
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
