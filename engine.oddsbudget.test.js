/**
 * engine.oddsbudget.test.js — monthly Odds API credit pacing.
 * Run: node engine.oddsbudget.test.js
 */
'use strict';
const assert = require('assert');
const { costOf, daysInMonth, seasonProgress, planDailySpend, dailyLedger, withinDailyBudget,
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


// ── The daily ledger ───────────────────────────────────────────────────────
// The guard that stops a DAY's allocation being spent once per RUN. Measured
// 22 Aug 2026: 36 leagues at 2 credits a request over 96 ticks a day is 6,912
// credits against an intended 2,880 — 207,360 a month on a 100,000 allowance.
test('a new UTC day re-baselines on the API counter', () => {
  const l = dailyLedger({ storedDay: '2026-08-21', storedUsedAtDayStart: 400, usedNow: 900, today: '2026-08-22' });
  assert.strictEqual(l.day, '2026-08-22');
  assert.strictEqual(l.usedAtDayStart, 900);
  assert.strictEqual(l.spentToday, 0);
});

test('within a day, spend is the counter difference', () => {
  const l = dailyLedger({ storedDay: '2026-08-22', storedUsedAtDayStart: 900, usedNow: 1044, today: '2026-08-22' });
  assert.strictEqual(l.spentToday, 144);
  assert.strictEqual(l.usedAtDayStart, 900, 'the baseline does not move mid-day');
});

test('a DROP in the counter is a billing reset, not a refund', () => {
  // The pool renews on the subscription date, mid-month. usedNow < baseline
  // would compute a NEGATIVE spend, which reads as unlimited headroom.
  const l = dailyLedger({ storedDay: '2026-08-22', storedUsedAtDayStart: 98000, usedNow: 0, today: '2026-08-22' });
  assert.strictEqual(l.usedAtDayStart, 0, 're-baselined');
  assert.strictEqual(l.spentToday, 0);
  assert.ok(l.spentToday >= 0, 'spend is never negative');
});

test('no counter yields unknown, never zero', () => {
  // 0 spent reads as a full day of headroom; unknown must stay unknown.
  const l = dailyLedger({ storedDay: '2026-08-22', storedUsedAtDayStart: 900, usedNow: null, today: '2026-08-22' });
  assert.strictEqual(l.spentToday, null);
  assert.strictEqual(l.usedAtDayStart, 900, 'the baseline survives a missing header');
});

test('the ceiling stops spend at the boundary, not past it', () => {
  assert.strictEqual(withinDailyBudget({ spentToday: 2876, cost: 2, ceiling: 2880 }), true);
  assert.strictEqual(withinDailyBudget({ spentToday: 2878, cost: 2, ceiling: 2880 }), true);
  assert.strictEqual(withinDailyBudget({ spentToday: 2879, cost: 2, ceiling: 2880 }), false);
  assert.strictEqual(withinDailyBudget({ spentToday: 9999, cost: 2, ceiling: 2880 }), false);
});

test('an unknown ledger FAILS OPEN — canSpend\'s reserve is underneath it', () => {
  // Refusing every request because a header was missing would take the board
  // down to protect a budget. The hard reserve still guards the pool.
  assert.strictEqual(withinDailyBudget({ spentToday: null, cost: 2, ceiling: 2880 }), true);
  assert.strictEqual(withinDailyBudget({ spentToday: 100, cost: 2, ceiling: null }), true);
  assert.strictEqual(withinDailyBudget({ spentToday: 100, cost: 2, ceiling: 0 }), true);
});

test('a day of ticks now costs the DAY budget, not the day budget per tick', () => {
  // Replay 72 ticks (20-minute cadence) against one ceiling and assert the
  // total lands on the allocation rather than 72x it.
  const ceiling = 2880, cost = 2, leagues = 36;
  let spent = 0;
  for (let tick = 0; tick < 72; tick++) {
    for (let i = 0; i < leagues; i++) {
      if (!withinDailyBudget({ spentToday: spent, cost, ceiling })) break;
      spent += cost;
    }
  }
  assert.strictEqual(spent, ceiling, `a day of ticks spent ${spent}, ceiling ${ceiling}`);
  assert.ok(spent * 31 < 100000, 'a full month stays inside the allowance');
});

console.log(`\nodds budget tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
