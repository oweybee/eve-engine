'use strict';

/**
 * engine.momentum.test.js — the corpus reads the feed's silence correctly.
 *
 * The whole value of `inplay_momentum` is that a fit over it later can trust
 * what is in it, and the one way to poison it is to write a zero where the feed
 * said nothing. `expected_goals` is absent on 41% of rows and those rows average
 * 12.9 shots — so a defaulted 0 there teaches a model which leagues report xG
 * rather than which sides are creating chances.
 *
 * Run: node engine.momentum.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const m = require('./lib/momentum');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const homeStats = [
  { type: 'Total Shots', value: 14 },
  { type: 'Shots on Goal', value: 6 },
  { type: 'Shots insidebox', value: 9 },
  { type: 'Corner Kicks', value: 7 },
  { type: 'Ball Possession', value: '67%' },
  { type: 'expected_goals', value: '1.82' },
  { type: 'Goalkeeper Saves', value: 2 },
  { type: 'Red Cards', value: null },
];
// A competition the feed does not track for xG — the 41% case.
const awayStats = [
  { type: 'Total Shots', value: 13 },
  { type: 'Shots on Goal', value: 5 },
  { type: 'Ball Possession', value: null },
  { type: 'expected_goals', value: null },
  { type: 'Red Cards', value: 1 },
];
const MATCH = { id: 'match-1', minute: 63, goals_home: 1, goals_away: 0 };
const NOW = new Date('2026-08-26T20:03:00Z');
const row = () => m.momentumRow(
  MATCH,
  { stats: homeStats, fetched_at: '2026-08-26T20:00:00Z' },
  { stats: awayStats, fetched_at: '2026-08-26T20:01:00Z' },
  NOW,
);

console.log('a null is UNKNOWN, except for a card');
test('an untracked xG stays null and is never a zero', () => {
  assert.strictEqual(row().xg_away, null);
  assert.strictEqual(row().poss_away, null);
});
test('a null Red Cards is a genuine NONE', () => {
  assert.strictEqual(row().reds_home, 0);
  assert.strictEqual(row().reds_away, 1);
});
test('a stat the feed omits entirely is unknown, not zero', () => {
  // The away side sends no Corner Kicks entry at all.
  assert.strictEqual(row().corners_away, null);
  assert.strictEqual(row().corners_home, 7);
});
test('a percentage string is a number', () => {
  assert.strictEqual(row().poss_home, 67);
});
test('the whole recorded state is what the feed sent', () => {
  const r = row();
  assert.deepStrictEqual(
    { s: [r.shots_home, r.shots_away], t: [r.sot_home, r.sot_away],
      i: [r.inside_home, r.inside_away], x: [r.xg_home, r.xg_away] },
    { s: [14, 13], t: [6, 5], i: [9, null], x: [1.82, null] },
  );
});

console.log('the observation carries the FEED\'s clock, not ours');
test('stats_fetched_at is the newest of the two sides', () => {
  assert.strictEqual(row().stats_fetched_at, '2026-08-26T20:01:00.000Z');
  assert.notStrictEqual(row().stats_fetched_at, row().captured_at,
    'ours is the tick; theirs is the observation, and dedupe reads theirs');
});
test('an undatable observation is null rather than now', () => {
  // Stamping it with our clock would make every re-read look like a new
  // observation and a fit would count one twice.
  assert.strictEqual(m.statsFetchedAt(null, null), null);
  assert.strictEqual(m.statsFetchedAt({ stats: [] }, null), null);
});
test('one side missing still dates the row by what it has', () => {
  assert.strictEqual(
    m.statsFetchedAt({ fetched_at: '2026-08-26T20:00:00Z' }, null),
    '2026-08-26T20:00:00.000Z');
});

console.log('no stats at all is no row');
test('both sides absent returns null, never an empty row', () => {
  assert.strictEqual(m.momentumRow(MATCH, null, null, NOW), null);
});
test('one side present is still a row', () => {
  const r = m.momentumRow(MATCH, { stats: homeStats, fetched_at: '2026-08-26T20:00:00Z' }, null, NOW);
  assert.strictEqual(r.shots_home, 14);
  assert.strictEqual(r.shots_away, null);
});

console.log('the description is a LOG LINE and nothing branches on it');
test('it reads the state without inventing one', () => {
  const line = m.describeMomentum(row());
  assert.ok(line.includes('14-13'), line);
  assert.ok(line.includes('?'), 'an unknown must be visibly unknown, not 0');
});
test('no stats says so', () => {
  assert.strictEqual(m.describeMomentum(null), 'no live stats');
});

console.log('the stat names are the feed\'s, and they are pinned');
test('a wrong string is a silent null, so the map is asserted', () => {
  assert.deepStrictEqual(m.STAT, {
    shots: 'Total Shots', sot: 'Shots on Goal', inside: 'Shots insidebox',
    corners: 'Corner Kicks', poss: 'Ball Possession', xg: 'expected_goals',
    saves: 'Goalkeeper Saves', reds: 'Red Cards',
  });
  assert.deepStrictEqual([...m.NULL_MEANS_ZERO], ['Red Cards'],
    'only a card may read a null as a none — everything else is untracked');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
