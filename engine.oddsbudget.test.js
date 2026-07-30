/**
 * engine.oddsbudget.test.js — monthly Odds API credit pacing.
 * Run: node engine.oddsbudget.test.js
 */
'use strict';
const assert = require('assert');
const { costOf, daysInMonth, seasonProgress, planDailySpend,
        leagueDayWeight, allocateByValue } = require('./lib/oddsApiBudget');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const MID = new Date('2026-08-15T12:00:00Z');   // mid-month

test('costOf mirrors regions x markets', () => {
  assert.strictEqual(costOf('uk', 'h2h'), 1);
  assert.strictEqual(costOf('uk', 'h2h,totals'), 2);
  assert.strictEqual(costOf('uk,eu', 'h2h,totals'), 4);
});

test('daysInMonth handles month lengths incl. leap Feb', () => {
  assert.strictEqual(daysInMonth(new Date('2026-08-10T00:00:00Z')), 31);
  assert.strictEqual(daysInMonth(new Date('2026-09-10T00:00:00Z')), 30);
  assert.strictEqual(daysInMonth(new Date('2028-02-10T00:00:00Z')), 29);
});

test('pacing follows FOOTBALL, not the calendar', () => {
  // Half the month's league-days played, but only 1/31 of the calendar gone.
  const p = seasonProgress({ now: new Date('2026-08-02T00:00:00Z'),
                             leagueDaysElapsed: 200, leagueDaysTotal: 400 });
  assert.ok(Math.abs(p - 0.5) < 1e-9, `should be 0.5, got ${p}`);
  // No forecast → falls back to calendar fraction
  const c = seasonProgress({ now: new Date('2026-08-16T00:00:00Z') });
  assert.ok(c > 0.45 && c < 0.55, `calendar fallback ~0.5, got ${c}`);
});

test('on-track month: pre-match floor honoured, surplus goes to in-play', () => {
  const p = planDailySpend({ allowance: 100000, used: 50000, now: MID,
    leagueDaysToday: 12, leagueDaysElapsed: 200, leagueDaysTotal: 400 });
  assert.strictEqual(p.pace, 'on-track');
  assert.ok(p.prematchPolls >= 8, `floor protected (${p.prematchPolls})`);
  assert.ok(p.inplayPolls > 0, 'surplus allocated to in-play');
  assert.ok(!p.exhausted);
});

test('OVERSPENDING trips the throttle and cuts spend', () => {
  const ahead = planDailySpend({ allowance: 100000, used: 85000, now: MID,
    leagueDaysToday: 12, leagueDaysElapsed: 200, leagueDaysTotal: 400 });
  const ontrack = planDailySpend({ allowance: 100000, used: 49000, now: MID,
    leagueDaysToday: 12, leagueDaysElapsed: 200, leagueDaysTotal: 400 });
  assert.strictEqual(ahead.pace, 'ahead');
  assert.ok(ahead.throttle < 1, `throttle applied (${ahead.throttle})`);
  assert.ok(ahead.todayAllocation < ontrack.todayAllocation,
    'an overspending month must spend less today');
});

test('UNDERSPENDING loosens, but never unboundedly', () => {
  const p = planDailySpend({ allowance: 100000, used: 5000, now: MID,
    leagueDaysToday: 12, leagueDaysElapsed: 200, leagueDaysTotal: 400 });
  assert.strictEqual(p.pace, 'behind');
  assert.ok(p.throttle > 1 && p.throttle <= 1.4, `bounded loosening (${p.throttle})`);
});

test('exhausted pool → nothing allocated (never negative)', () => {
  const p = planDailySpend({ allowance: 100000, used: 99500, reserve: 2000, now: MID,
    leagueDaysToday: 12, leagueDaysElapsed: 380, leagueDaysTotal: 400 });
  assert.strictEqual(p.exhausted, true);
  assert.strictEqual(p.spendable, 0);
  assert.strictEqual(p.inplayPolls, 0);
  assert.ok(p.prematchPolls >= 0 && p.prematchCost >= 0);
});

test('never plans beyond the spendable pool (sweep)', () => {
  for (const used of [0, 25000, 60000, 90000, 99000]) {
    for (const lds of [1, 12, 30]) {
      const p = planDailySpend({ allowance: 100000, used, now: MID,
        leagueDaysToday: lds, leagueDaysElapsed: 200, leagueDaysTotal: 400 });
      assert.ok(p.todayAllocation <= p.spendable + 1,
        `used=${used} lds=${lds}: allocated ${p.todayAllocation} > spendable ${p.spendable}`);
    }
  }
});

test('busy month (449 league-days) still affords the breadth floor', () => {
  const p = planDailySpend({ allowance: 100000, used: 0, now: new Date('2026-08-01T00:00:00Z'),
    leagueDaysToday: 20, leagueDaysElapsed: 0, leagueDaysTotal: 449 });
  assert.ok(p.prematchPolls >= 8, `floor affordable on a busy month (${p.prematchPolls})`);
  assert.ok(p.creditsPerLeagueDay >= 16, `~${p.creditsPerLeagueDay} credits per league-day`);
});

test('value weighting: more fixtures and proven leagues rank higher', () => {
  assert.ok(leagueDayWeight({ fixtures: 10, tag: 'proven' })
          > leagueDayWeight({ fixtures: 10, tag: 'neutral' }));
  assert.ok(leagueDayWeight({ fixtures: 10, tag: 'neutral' })
          > leagueDayWeight({ fixtures: 1, tag: 'neutral' }));
  assert.ok(leagueDayWeight({ fixtures: 1, tag: 'avoid' })
          < leagueDayWeight({ fixtures: 1, tag: 'neutral' }));
});

test('allocateByValue respects the floor and the total', () => {
  const leagues = [
    { key: 'epl', fixtures: 10, tag: 'proven' },
    { key: 'china_superleague', fixtures: 8, tag: 'avoid' },
    { key: 'n1', fixtures: 2, tag: 'neutral' },
  ];
  const a = allocateByValue(leagues, 60, { floor: 2 });
  assert.ok(Object.values(a).every(v => v >= 2), 'no league starved');
  assert.ok(Object.values(a).reduce((s, v) => s + v, 0) <= 60, 'within total');
  assert.ok(a.epl > a.china_superleague, 'proven league outranks the avoid list');
  assert.deepStrictEqual(allocateByValue([], 50), {});
});

console.log(`\nodds budget tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
