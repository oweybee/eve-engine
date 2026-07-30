/**
 * engine.pollbudget.test.js — adaptive polling-budget planner tests.
 * Run: node engine.pollbudget.test.js
 */
'use strict';

const assert = require('assert');
const { planPolling, pollsForFixture, tierFor, dueNow, DEFAULT_TIERS } =
  require('./lib/pollBudget');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

const NOW = new Date('2026-08-15T09:00:00Z');
const inHours = h => new Date(NOW.getTime() + h * 3600_000).toISOString();
const makeFixtures = specs => specs.map((h, i) => ({ id: `f${i}`, kickoffAt: inHours(h) }));

test('pollsForFixture: full life ≈ 68 polls under default tiers', () => {
  const n = pollsForFixture(72, DEFAULT_TIERS);
  assert.strictEqual(n, 36 + 18 + 12 + 2, `got ${n}`);
});

test('pollsForFixture: near-kickoff fixture only pays the closing tier', () => {
  assert.strictEqual(pollsForFixture(3, DEFAULT_TIERS), 36);
  assert.strictEqual(pollsForFixture(1, DEFAULT_TIERS), 12);
  assert.strictEqual(pollsForFixture(0, DEFAULT_TIERS), 0);
});

test('tierFor picks the right band', () => {
  assert.strictEqual(tierFor(1, DEFAULT_TIERS).key, 'closing');
  assert.strictEqual(tierFor(6, DEFAULT_TIERS).key, 'dayof');
  assert.strictEqual(tierFor(30, DEFAULT_TIERS).key, 'near');
  assert.strictEqual(tierFor(60, DEFAULT_TIERS).key, 'far');
  assert.strictEqual(tierFor(-1, DEFAULT_TIERS), null);
});

test('generous budget: no degradation, everything covered', () => {
  const plan = planPolling({
    fixtures: makeFixtures([2, 6, 20, 50]), budget: 150000, now: NOW,
  });
  assert.strictEqual(plan.degradations.length, 0);
  assert.strictEqual(plan.covered, 4);
  assert.strictEqual(plan.dropped, 0);
  assert.ok(plan.cost.total < 300, `cheap day should be cheap (${plan.cost.total})`);
});

test('busiest day fits comfortably inside 150k', () => {
  // 177 fixtures spread across the next 72h, plus realistic reserves
  const specs = Array.from({ length: 177 }, (_, i) => 1 + (i % 72));
  const plan = planPolling({
    fixtures: makeFixtures(specs), budget: 150000, now: NOW,
    reserve: { live: 4752, details: 531, planner: 120 },
  });
  assert.strictEqual(plan.degradations.length, 0, 'should not need to degrade');
  assert.strictEqual(plan.dropped, 0);
  assert.ok(plan.cost.utilisation < 0.25,
    `busiest day should use <25% of 150k (used ${plan.cost.utilisation})`);
});

test('tight budget degrades far tiers FIRST, protects the closing line', () => {
  const specs = Array.from({ length: 60 }, (_, i) => 1 + (i % 72));
  const plan = planPolling({ fixtures: makeFixtures(specs), budget: 2500, now: NOW });
  assert.ok(plan.degradations.length > 0, 'should have degraded');
  const closing = plan.tiers.find(t => t.key === 'closing');
  const far = plan.tiers.find(t => t.key === 'far');
  assert.ok(far.everyMin > 720, 'far tier should widen');
  assert.strictEqual(closing.everyMin, 5, 'closing tier must stay 5m while cheaper tiers can give');
  assert.ok(plan.cost.total <= 2500, `must fit budget (${plan.cost.total})`);
});

test('free-tier cap (100/day): still fits, nearest kickoff prioritised', () => {
  const specs = [0.5, 1, 2, 5, 20, 40, 65];
  const plan = planPolling({
    fixtures: makeFixtures(specs), budget: 100, now: NOW,
    reserve: { planner: 3 },
  });
  assert.ok(plan.cost.total <= 100, `must never exceed budget (${plan.cost.total})`);
  if (plan.dropped > 0) {
    // whatever survived must be the most imminent fixtures
    const keptMax = Math.max(...plan.schedule.map(s => s.hoursToKickoff));
    const allH = specs.slice().sort((a, b) => a - b);
    assert.ok(keptMax <= allH[plan.covered - 1] + 1e-6,
      'kept fixtures must be the nearest-kickoff ones');
  }
});

test('never exceeds budget across a wide sweep', () => {
  for (const budget of [50, 100, 500, 2000, 7500, 75000]) {
    for (const n of [1, 10, 60, 177]) {
      const specs = Array.from({ length: n }, (_, i) => 0.5 + (i % 72));
      const plan = planPolling({
        fixtures: makeFixtures(specs), budget, now: NOW, reserve: { planner: 5 },
      });
      assert.ok(plan.cost.total <= budget,
        `budget=${budget} n=${n} → spent ${plan.cost.total}`);
    }
  }
});

test('past-kickoff fixtures are excluded', () => {
  const plan = planPolling({
    fixtures: [
      { id: 'past', kickoffAt: inHours(-2) },
      { id: 'live', kickoffAt: inHours(-0.1) },
      { id: 'next', kickoffAt: inHours(2) },
    ], budget: 10000, now: NOW,
  });
  assert.strictEqual(plan.covered, 1);
  assert.strictEqual(plan.schedule[0].id, 'next');
});

test('dueNow filters on nextPollAt', () => {
  const plan = planPolling({ fixtures: makeFixtures([1, 30]), budget: 150000, now: NOW });
  assert.strictEqual(dueNow(plan.schedule, NOW).length, 0, 'nothing due immediately');
  const later = new Date(NOW.getTime() + 10 * 60_000);
  assert.strictEqual(dueNow(plan.schedule, later).length, 1, 'closing-tier fixture due at +10m');
});

console.log(`\npoll budget tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
