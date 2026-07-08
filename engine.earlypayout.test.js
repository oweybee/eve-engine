'use strict';

// Tests for the "2 goals ahead" early payout (2UP) logic:
//   lib/earlyPayout.js       — pure market/lead rules
//   lib/apiFootballEvents.js — goal-timeline normalisation
// The headline scenario is the real one that motivated the feature: a team backed
// to win goes 2-0 up (early payout triggers), then loses the match — a LOSS on
// the final score but a real-money WIN.

const assert = require('assert');
const {
  TWO_UP, marketQualifies, maxLeads, ledByTwo, isEarlyPayout,
} = require('./lib/earlyPayout');
const { goalTimelineFromEvents } = require('./lib/apiFootballEvents');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

const namesMatch = (a, b) => {
  const n = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = n(a), nb = n(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
};

// ---- marketQualifies ----
console.log('\nearlyPayout — marketQualifies (only 1X2 win singles)');
test('home 1X2 qualifies',      () => assert.strictEqual(marketQualifies('h2h', 'home'), true));
test('away 1X2 qualifies',      () => assert.strictEqual(marketQualifies('h2h', 'away'), true));
test('1x2 alias qualifies',     () => assert.strictEqual(marketQualifies('1x2', 'away'), true));
test('undefined market → h2h',  () => assert.strictEqual(marketQualifies(undefined, 'home'), true));
test('draw never qualifies',    () => assert.strictEqual(marketQualifies('h2h', 'draw'), false));
test('btts never qualifies',    () => assert.strictEqual(marketQualifies('btts', 'btts_yes'), false));
test('totals never qualifies',  () => assert.strictEqual(marketQualifies('totals', 'over'), false));

// ---- maxLeads (timeline replay) ----
console.log('\nearlyPayout — maxLeads');
test('2-0 then 2-3: home peaked at +2, away ended +1', () => {
  // Egypt (home) 2-0 up, conceded 3: goals H,H,A,A,A
  const goals = [
    { team: 'home', minute: 12 }, { team: 'home', minute: 34 },
    { team: 'away', minute: 55 }, { team: 'away', minute: 70 }, { team: 'away', minute: 88 },
  ];
  assert.deepStrictEqual(maxLeads(goals), { home: 2, away: 1 });
});
test('nil-nil: no lead either side', () => assert.deepStrictEqual(maxLeads([]), { home: 0, away: 0 }));
test('1-0 only: max lead +1', () => assert.deepStrictEqual(maxLeads([{ team: 'home', minute: 5 }]), { home: 1, away: 0 }));
test('malformed entries ignored', () => assert.deepStrictEqual(
  maxLeads([{ team: 'home' }, { team: 'x' }, { team: null }, { team: 'home' }]), { home: 2, away: 0 }));

// ---- ledByTwo + isEarlyPayout ----
console.log('\nearlyPayout — isEarlyPayout (the Egypt case)');
const egyptGoals = [
  { team: 'home', minute: 12 }, { team: 'home', minute: 34 }, // 2-0 up → 2UP triggers
  { team: 'away', minute: 55 }, { team: 'away', minute: 70 }, { team: 'away', minute: 88 }, // lost 2-3
];
test('backed home, 2-0 up then lost → early payout', () =>
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'home', goals: egyptGoals }), true));
test('backed away in same match → NOT an early payout (away never led by 2)', () =>
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'away', goals: egyptGoals }), false));
test('backed home, only ever 1-0 up → no early payout', () =>
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'home',
    goals: [{ team: 'home', minute: 5 }, { team: 'away', minute: 90 }] }), false));
test('draw selection never an early payout even at 2-0', () =>
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'draw', goals: egyptGoals }), false));
test('no evidence → false (never assumed)', () =>
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'home' }), false));

console.log('\nearlyPayout — half-time fallback');
test('2-0 at HT, backed home → early payout via halftime score', () =>
  assert.strictEqual(ledByTwo('home', { halftime: { home: 2, away: 0 } }), true));
test('1-0 at HT, backed home → no early payout from HT alone', () =>
  assert.strictEqual(ledByTwo('home', { halftime: { home: 1, away: 0 } }), false));
test('timeline preferred over HT when both present', () =>
  assert.strictEqual(ledByTwo('home', { goals: [{ team: 'home', minute: 80 }, { team: 'home', minute: 85 }],
    halftime: { home: 0, away: 0 } }), true)); // 2-goal lead came after HT

// ---- goalTimelineFromEvents (API-Football adapter) ----
console.log('\napiFootballEvents — goalTimelineFromEvents');
test('maps events to home/away by name, ordered by minute', () => {
  const events = [
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Egypt' },       time: { elapsed: 34 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Ghana' },       time: { elapsed: 55 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Egypt' },       time: { elapsed: 12 } },
  ];
  const goals = goalTimelineFromEvents(events, 'Egypt', 'Ghana', namesMatch);
  assert.deepStrictEqual(goals, [
    { team: 'home', minute: 12 }, { team: 'home', minute: 34 }, { team: 'away', minute: 55 },
  ]);
});
test('own goal credited to the opponent', () => {
  const events = [{ type: 'Goal', detail: 'Own Goal', team: { name: 'Ghana' }, time: { elapsed: 20 } }];
  // Ghana (away) own goal → counts for Egypt (home)
  assert.deepStrictEqual(goalTimelineFromEvents(events, 'Egypt', 'Ghana', namesMatch),
    [{ team: 'home', minute: 20 }]);
});
test('missed penalties and shootout goals excluded', () => {
  const events = [
    { type: 'Goal', detail: 'Missed Penalty',  team: { name: 'Egypt' }, time: { elapsed: 60 } },
    { type: 'Goal', detail: 'Penalty', comments: 'Penalty Shootout', team: { name: 'Egypt' }, time: { elapsed: 120 } },
    { type: 'Card', detail: 'Yellow Card',      team: { name: 'Egypt' }, time: { elapsed: 30 } },
    { type: 'Goal', detail: 'Normal Goal',      team: { name: 'Egypt' }, time: { elapsed: 45 } },
  ];
  assert.deepStrictEqual(goalTimelineFromEvents(events, 'Egypt', 'Ghana', namesMatch),
    [{ team: 'home', minute: 45 }]);
});
test('full pipeline: events → timeline → early payout', () => {
  const events = [
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Egypt' }, time: { elapsed: 12 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Egypt' }, time: { elapsed: 34 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Ghana' }, time: { elapsed: 55 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Ghana' }, time: { elapsed: 70 } },
    { type: 'Goal', detail: 'Normal Goal', team: { name: 'Ghana' }, time: { elapsed: 88 } },
  ];
  const goals = goalTimelineFromEvents(events, 'Egypt', 'Ghana', namesMatch);
  assert.strictEqual(isEarlyPayout({ market: 'h2h', outcome: 'home', goals }), true);
});

test('TWO_UP constant is 2', () => assert.strictEqual(TWO_UP, 2));

console.log(`\nearlyPayout: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
