'use strict';

/**
 * engine.sniper.test.js — Second Half Sniper pure logic:
 *   goalsOverProb (lib/inplayWinProb) · bestTotalsByLine (lib/inplay) ·
 *   sniperCandidates (lib/secondHalfSniper) · extractLiveTotals (ingestLiveOdds).
 * Run: node engine.sniper.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const wp = require('./lib/inplayWinProb');
const inplay = require('./lib/inplay');
const { sniperCandidates, isHalftimeWindow } = require('./lib/secondHalfSniper');
const { extractLiveTotals } = require('./ingestLiveOdds');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log('goalsOverProb — boundary cases');
test('already over the line → 1', () => {
  assert.strictEqual(wp.goalsOverProb({ lambdaHome: 1.3, lambdaAway: 1.2, homeGoals: 2, awayGoals: 1, minute: 46, line: 2.5 }), 1);
});
test('full time, under the line → 0', () => {
  // minute 90 → no time left → remaining is 0, 1-0 stays under 1.5.
  assert.ok(close(wp.goalsOverProb({ lambdaHome: 1.4, lambdaAway: 1.1, homeGoals: 1, awayGoals: 0, minute: 90, line: 1.5 }), 0));
});
test('0-0 at kickoff equals the pre-match Over prob', () => {
  // At minute 0 the whole match remains → P(total>2.5) from Poisson(λ_total).
  const lambdaTotal = 1.6 + 1.1;
  const pmf = wp.poissonPmfArray(lambdaTotal);
  const pOver = 1 - (pmf[0] + pmf[1] + pmf[2]);  // P(≥3 goals) for line 2.5
  const got = wp.goalsOverProb({ lambdaHome: 1.6, lambdaAway: 1.1, homeGoals: 0, awayGoals: 0, minute: 0, line: 2.5 });
  assert.ok(close(got, pOver, 1e-9), `${got} vs ${pOver}`);
});
test('monotonic: more goals already scored → higher P(Over)', () => {
  const base = { lambdaHome: 1.4, lambdaAway: 1.2, minute: 46, line: 2.5 };
  const p00 = wp.goalsOverProb({ ...base, homeGoals: 0, awayGoals: 0 });
  const p10 = wp.goalsOverProb({ ...base, homeGoals: 1, awayGoals: 0 });
  assert.ok(p10 > p00, `1-0 ${p10} should exceed 0-0 ${p00}`);
});
test('probability in [0,1]', () => {
  const p = wp.goalsOverProb({ lambdaHome: 2.0, lambdaAway: 1.5, homeGoals: 1, awayGoals: 0, minute: 45, line: 1.5 });
  assert.ok(p >= 0 && p <= 1);
});
test('Monte-Carlo cross-check within 1.5pp', () => {
  let seed = 987654321;
  const rnd = () => { seed = (1103515245 * seed + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const poissonSample = (L) => { const Lm = Math.exp(-L); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > Lm); return k - 1; };
  const lambdaHome = 1.5, lambdaAway = 1.2, gh = 0, ga = 0, minute = 45, line = 1.5;
  const f = wp.timeLeftFraction(minute), N = 60000;
  let over = 0;
  for (let n = 0; n < N; n++) {
    const total = gh + ga + poissonSample((lambdaHome + lambdaAway) * f);
    if (total > line) over++;
  }
  const sim = over / N;
  const ana = wp.goalsOverProb({ lambdaHome, lambdaAway, homeGoals: gh, awayGoals: ga, minute, line });
  assert.ok(Math.abs(sim - ana) < 0.015, `sim ${sim.toFixed(3)} vs ana ${ana.toFixed(3)}`);
});

console.log('bestTotalsByLine');
test('picks best over/under per line, ignores non-totals', () => {
  const rows = [
    { market: 'h2h', home_odds: 2.0, draw_odds: 3.3, away_odds: 3.8 },
    { market: 'totals', market_line: 1.5, bookmaker: 'a', home_odds: 1.80, away_odds: 2.00 },
    { market: 'totals', market_line: 1.5, bookmaker: 'b', home_odds: 1.85, away_odds: 1.95 },
    { market: 'totals', market_line: 2.5, bookmaker: 'a', home_odds: 2.60, away_odds: 1.50 },
  ];
  const byLine = inplay.bestTotalsByLine(rows);
  assert.strictEqual(byLine.get(1.5).over.odds, 1.85);
  assert.strictEqual(byLine.get(1.5).over.book, 'b');
  assert.strictEqual(byLine.get(2.5).over.odds, 2.60);
  assert.ok(!byLine.has(undefined));
});
test('drops junk prices (≤1 or ≥1000)', () => {
  const byLine = inplay.bestTotalsByLine([
    { market: 'totals', market_line: 2.5, bookmaker: 'a', home_odds: 1.0, away_odds: 1500 },
  ]);
  assert.strictEqual(byLine.get(2.5).over, null);
  assert.strictEqual(byLine.get(2.5).under, null);
});

console.log('isHalftimeWindow');
test('45 is in the break window', () => assert.ok(isHalftimeWindow(45)));
test('30 is not', () => assert.ok(!isHalftimeWindow(30)));
test('70 is not', () => assert.ok(!isHalftimeWindow(70)));
test('null minute is not', () => assert.ok(!isHalftimeWindow(null)));

console.log('sniperCandidates');
const baseline = { lambda_home: 1.6, lambda_away: 1.3 };   // λ_total 2.9 → goals expected
// At 0-0, minute 45, λ_total·time-left = 1.45 → P(Over 1.5)≈0.425, P(Over 2.5)≈0.179.
// Value needs a DRIFTED live Over price: Over 1.5 @ 2.60 → edge≈0.106; Over 2.5 @
// 6.0 → edge≈0.072. Both positive, so the sniper must pick the higher (1.5).
const liveMatch = (over = {}) => ({
  id: 'm1', kickoff_at: '2026-07-01T16:00:00Z',
  goals_home: 0, goals_away: 0, minute: 45,
  home_team: { name: 'A' }, away_team: { name: 'B' },
  odds: [
    { market: 'totals', market_line: 1.5, bookmaker: 'live', home_odds: 2.60, away_odds: 1.50 },
    { market: 'totals', market_line: 2.5, bookmaker: 'live', home_odds: 6.00, away_odds: 1.12 },
  ],
  ...over,
});
const opts = { evThreshold: 0.02, maxEdge: 0.20 };

test('emits a single SECOND_HALF_SNIPER over candidate on a hot 0-0', () => {
  const c = sniperCandidates(liveMatch(), baseline, opts);
  assert.strictEqual(c.length, 1, 'exactly one entry per fixture');
  assert.strictEqual(c[0].model_architecture, 'SECOND_HALF_SNIPER');
  assert.strictEqual(c[0].market, 'totals');
  assert.strictEqual(c[0].outcome, 'over');
  assert.strictEqual(c[0].phase, 'inplay');
  assert.ok([1.5, 2.5].includes(c[0].market_line));
  assert.ok(c[0].detected_edge >= 0.02 && c[0].detected_edge <= 0.20, `edge ${c[0].detected_edge}`);
});
test('picks the higher-EV line when both qualify', () => {
  // Over 1.5 @ 2.60 (edge≈0.106) beats Over 2.5 @ 6.0 (edge≈0.072) → line 1.5.
  const c = sniperCandidates(liveMatch(), baseline, opts);
  assert.strictEqual(c[0].market_line, 1.5);
});
test('no baseline → nothing', () => {
  assert.strictEqual(sniperCandidates(liveMatch(), null, opts).length, 0);
});
test('goals-light match (low λ) → nothing', () => {
  assert.strictEqual(sniperCandidates(liveMatch(), { lambda_home: 0.8, lambda_away: 0.7 }, opts).length, 0);
});
test('outside the half-time window → nothing', () => {
  assert.strictEqual(sniperCandidates(liveMatch({ minute: 70 }), baseline, opts).length, 0);
});
test('cooled-off scoreline (2-1 at the break) → nothing', () => {
  assert.strictEqual(sniperCandidates(liveMatch({ goals_home: 2, goals_away: 1 }), baseline, opts).length, 0);
});
test('no live totals price → nothing', () => {
  assert.strictEqual(sniperCandidates(liveMatch({ odds: [] }), baseline, opts).length, 0);
});
test('short (no-edge) over price → nothing', () => {
  const c = sniperCandidates(liveMatch({ odds: [
    { market: 'totals', market_line: 1.5, bookmaker: 'live', home_odds: 1.05, away_odds: 8.0 },
    { market: 'totals', market_line: 2.5, bookmaker: 'live', home_odds: 1.30, away_odds: 3.4 },
  ] }), baseline, opts);
  assert.strictEqual(c.length, 0);
});
test('miscalibrated generous price is capped out', () => {
  const c = sniperCandidates(liveMatch({ odds: [
    { market: 'totals', market_line: 2.5, bookmaker: 'live', home_odds: 50.0, away_odds: 1.01 },
  ] }), baseline, opts);
  assert.strictEqual(c.length, 0);
});

console.log('extractLiveTotals (ingest parsing)');
test('parses "Over 1.5" / "Under 1.5" value strings', () => {
  const out = extractLiveTotals([
    { name: 'Over/Under', values: [
      { value: 'Over 1.5', odd: '1.40' }, { value: 'Under 1.5', odd: '2.90' },
      { value: 'Over 2.5', odd: '2.30' }, { value: 'Under 2.5', odd: '1.60' },
    ] },
  ]);
  const l15 = out.find(t => t.line === 1.5);
  assert.ok(l15 && l15.over === 1.40 && l15.under === 2.90);
  assert.strictEqual(out.length, 2);
});
test('parses value="Over" with a separate handicap field', () => {
  const out = extractLiveTotals([
    { name: 'Goals Over/Under', values: [
      { value: 'Over', handicap: '2.5', odd: '2.10' }, { value: 'Under', handicap: '2.5', odd: '1.72' },
    ] },
  ]);
  assert.deepStrictEqual(out, [{ line: 2.5, over: 2.10, under: 1.72 }]);
});
test('skips suspended values and junk odds', () => {
  const out = extractLiveTotals([
    { name: 'Over/Under', values: [
      { value: 'Over 2.5', odd: '2.10' }, { value: 'Under 2.5', odd: '1.72', suspended: true },
      { value: 'Over 3.5', odd: '1.00' },   // junk price ≤ 1
    ] },
  ]);
  const l25 = out.find(t => t.line === 2.5);
  assert.ok(l25 && l25.over === 2.10 && l25.under === null);
  assert.ok(!out.find(t => t.line === 3.5));  // both sides dropped
});
test('ignores corners/cards over-under markets', () => {
  assert.strictEqual(extractLiveTotals([
    { name: 'Corners Over/Under', values: [{ value: 'Over 9.5', odd: '1.90' }] },
  ]).length, 0);
});
test('no goals market → empty', () => {
  assert.strictEqual(extractLiveTotals([{ name: 'Match Winner', values: [] }]).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
