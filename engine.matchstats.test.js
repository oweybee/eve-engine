/**
 * engine.matchstats.test.js — historical /fixtures/statistics backfill.
 * Run: node engine.matchstats.test.js
 *
 * Covers the pure logic only: the season window, which external_ids the API can
 * be asked about, HTTP-200-with-errors detection, home/away orientation, and
 * what counts as a metric being present. Every one of these has a failure mode
 * that is silent in a log and permanent in the data.
 */
'use strict';
const assert = require('assert');
const { seasonWindow, spanOf, isApiFixtureId, apiErrors, normaliseName,
        orientSides, coverageOf, statRows, rateLimiter } = require('./backfillMatchStats');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}
async function atest(n, f) {
  try { await f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

// ── season windows ──────────────────────────────────────────────────────────
// A fixture that falls outside the window is never fetched and is a permanent
// hole in that team's rolling form, so the window is deliberately generous.

test('a season spans July to the following June', () => {
  assert.deepStrictEqual(seasonWindow(2024), { from: '2024-07-01', to: '2025-06-30' });
});

test('several seasons collapse to one span, not N queries', () => {
  assert.deepStrictEqual(spanOf([2025, 2024]), { from: '2024-07-01', to: '2026-06-30' });
  assert.deepStrictEqual(spanOf([2024]),       { from: '2024-07-01', to: '2025-06-30' });
});

// ── which fixtures the API can answer for ───────────────────────────────────
// The CSV and StatsBomb seeds are the entire historical corpus and carry
// prefixed ids. Asking the API about one burns a call to be told nothing, and
// 36,000 of them would burn half a day's quota.

test('only numeric external_ids are API fixture ids', () => {
  assert.strictEqual(isApiFixtureId('1035213'), true);
  assert.strictEqual(isApiFixtureId(1035213),   true);
  assert.strictEqual(isApiFixtureId('datahub_10521'), false);
  assert.strictEqual(isApiFixtureId('sb_3773689'),    false);
  assert.strictEqual(isApiFixtureId(''),   false);
  assert.strictEqual(isApiFixtureId(null), false);
  assert.strictEqual(isApiFixtureId('12a'), false);
});

// ── HTTP 200 with an errors payload ─────────────────────────────────────────
// API-Football answers a plan-gated request with 200 + errors + an empty
// response, which is indistinguishable from "no statistics recorded" unless the
// errors field is read. Getting this wrong writes an empty marker over a
// fixture that does have data, and never asks again.

test('errors are read whether the API sends an array or an object', () => {
  assert.deepStrictEqual(apiErrors({ errors: [] }), []);
  assert.deepStrictEqual(apiErrors({ errors: {} }), []);
  assert.deepStrictEqual(apiErrors({ response: [] }), []);
  assert.deepStrictEqual(apiErrors({ errors: { plan: 'Free plans do not have access' } }),
                         ['Free plans do not have access']);
  assert.deepStrictEqual(apiErrors({ errors: ['rate limit'] }), ['rate limit']);
});

// ── home / away orientation ─────────────────────────────────────────────────
// Transposed corner counts are invisible: the totals are unchanged, so only the
// per-venue rolling form is wrong — which is exactly the feature the corners
// and cards models are built on.

const block = (name, stats) => ({ team: { name }, statistics: stats });

test('orients by team name when the names agree', () => {
  const r = orientSides([block('Arsenal', [{ type: 'Corner Kicks', value: 7 }]),
                         block('Chelsea', [{ type: 'Corner Kicks', value: 3 }])],
                        'Arsenal', 'Chelsea');
  assert.strictEqual(r.byName, true);
  assert.deepStrictEqual(r.sides.map(s => s.side), ['home', 'away']);
  assert.strictEqual(r.sides[0].stats[0].value, 7);
});

test('a reversed response is corrected, not trusted', () => {
  const r = orientSides([block('Chelsea', [{ type: 'Corner Kicks', value: 3 }]),
                         block('Arsenal', [{ type: 'Corner Kicks', value: 7 }])],
                        'Arsenal', 'Chelsea');
  assert.strictEqual(r.byName, true);
  assert.deepStrictEqual(r.sides.map(s => s.side), ['away', 'home']);
  // The home team's seven corners must still be attached to the home side.
  assert.strictEqual(r.sides.find(s => s.side === 'home').stats[0].value, 7);
});

test('punctuation and case do not defeat the match', () => {
  assert.strictEqual(normaliseName('Bayern München'), 'bayernmunchen');
  const r = orientSides([block('bayern munchen', []), block('BORUSSIA DORTMUND', [])],
                        'Bayern München', 'Borussia Dortmund');
  assert.strictEqual(r.byName, true);
  assert.deepStrictEqual(r.sides.map(s => s.side), ['home', 'away']);
});

test('a name it cannot resolve falls back to API order rather than guessing', () => {
  // Deliberate. Both names come from the same feed so they normally agree
  // exactly; when they do not — an abbreviation, a renamed club — a fuzzy guess
  // that lands the wrong way round transposes the per-venue form silently,
  // which is strictly worse than the [home, away] assumption every other script
  // in this repo already makes. So: fall back, and count it in the report.
  const r = orientSides([block('Nott. Forest', []), block('Team B', [])],
                        'Nottingham Forest', 'Kalmar FF');
  assert.strictEqual(r.byName, false);
  assert.deepStrictEqual(r.sides.map(s => s.side), ['home', 'away']);
});

test('an empty response is null, not a pair of empty sides', () => {
  // The caller distinguishes these: null means "the API had nothing, mark it and
  // never ask again", whereas a side with an empty stats array means "this team
  // reported no statistics", and they must not be conflated.
  assert.strictEqual(orientSides([], 'A', 'B'), null);
  assert.strictEqual(orientSides(null, 'A', 'B'), null);
  assert.strictEqual(orientSides(undefined, 'A', 'B'), null);
});

test('a one-sided response yields one side rather than crashing', () => {
  const r = orientSides([block('Arsenal', [])], 'Arsenal', 'Chelsea');
  assert.deepStrictEqual(r.sides.map(s => s.side), ['home']);
});

// ── metric presence ─────────────────────────────────────────────────────────
// A `type` present with a null value must count as ABSENT. Treating a missing
// "Yellow Cards" entry as a 0-card game roughly halves a league's card average —
// the same trap fetchTeamStats had to guard against with MIN_CARD_SAMPLE.

test('a null value is not coverage', () => {
  const cov = coverageOf([{ side: 'home', stats: [
    { type: 'Corner Kicks',   value: 7 },
    { type: 'Yellow Cards',   value: null },
    { type: 'expected_goals', value: '1.42' },
  ] }]);
  assert.strictEqual(cov.corners, true);
  assert.strictEqual(cov.yellows, false);
  assert.strictEqual(cov.xg,      true);
  assert.strictEqual(cov.reds,    false);
});

test('coverage is the union across both sides', () => {
  const cov = coverageOf([
    { side: 'home', stats: [{ type: 'Corner Kicks', value: 7 }] },
    { side: 'away', stats: [{ type: 'Yellow Cards', value: 2 }] },
  ]);
  assert.strictEqual(cov.corners, true);
  assert.strictEqual(cov.yellows, true);
});

test('zero is a real value, not an absence', () => {
  const cov = coverageOf([{ side: 'home', stats: [{ type: 'Red Cards', value: 0 }] }]);
  assert.strictEqual(cov.reds, true);
});

// ── row shape ───────────────────────────────────────────────────────────────
// Must match what fetchLiveStats writes, or migration 051's
// mx_refresh_team_match() reads half the table.

test('rows carry a string fixture_id and the raw array', () => {
  const rows = statRows(1035213, [{ side: 'home', stats: [{ type: 'Corner Kicks', value: 7 }] },
                                  { side: 'away', stats: [] }], '2026-08-05T00:00:00.000Z');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].fixture_id, '1035213');
  assert.strictEqual(typeof rows[0].fixture_id, 'string');
  assert.strictEqual(rows[0].team_side, 'home');
  assert.deepStrictEqual(rows[1].stats, []);
  assert.strictEqual(rows[0].fetched_at, '2026-08-05T00:00:00.000Z');
});

// ── pacing ──────────────────────────────────────────────────────────────────
// The per-day allowance is the headline limit; the per-minute one is what
// actually 429s a tight loop, and a 429 storm wastes the quota it protects.

atest('the limiter lets the first N through without waiting', async () => {
  const take = rateLimiter(5);
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await take();
  assert.ok(Date.now() - t0 < 200, 'first N calls should not block');
}).then(() => {
  console.log(`\n${passed} test(s) passed`);
});
