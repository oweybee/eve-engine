'use strict';

/**
 * engine.hitzone.test.js — the in-play momentum study.
 *
 * The study exists to answer one question honestly, so these pin the four
 * things that decide whether the answer means anything: the baseline is the
 * PRICE, the orientation is the SELECTION's, a match contributes ONE
 * observation, and the bar rises with how many places we looked.
 *
 * Run: node engine.hitzone.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const hz = require('./lib/hitZone');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('the multiple-testing bar');
test('k=1 is the familiar 1.96', () => {
  assert.ok(close(hz.bonferroniZ(1), 1.959964, 1e-4), String(hz.bonferroniZ(1)));
});
test('the bar RISES with how many places we looked', () => {
  assert.ok(hz.bonferroniZ(4) > hz.bonferroniZ(1));
  assert.ok(hz.bonferroniZ(120) > hz.bonferroniZ(4));
  // /leagues corrects to 3.520 over 116 clubs; 120 hypotheses lands beside it.
  assert.ok(close(hz.bonferroniZ(120), 3.529, 0.01), String(hz.bonferroniZ(120)));
});
test('it reproduces the "~6 by chance out of 120" claim', () => {
  assert.ok(close(hz.expectedFalsePositives(120), 5.46, 0.1),
    String(hz.expectedFalsePositives(120)));
});

console.log('a zone measures against the PRICE');
test('a zone that matches its price finds nothing', () => {
  // 100 observations the market priced at 0.60 and which landed 60 times.
  const obs = Array.from({ length: 100 }, (_, i) => ({ pMarket: 0.6, won: i < 60, odds: 1.7 }));
  const s = hz.zoneStats(obs);
  assert.strictEqual(s.n, 100);
  assert.ok(close(s.expected, 0.6), String(s.expected));
  assert.ok(close(s.realised, 0.6), String(s.realised));
  assert.ok(Math.abs(s.z) < 1e-9, `z ${s.z} must be zero when the price was right`);
});
test('beating the price is a POSITIVE z, and it scales with n', () => {
  const mk = n => Array.from({ length: n }, (_, i) => ({ pMarket: 0.5, won: i < n * 0.6, odds: 2.0 }));
  const small = hz.zoneStats(mk(50));
  const big = hz.zoneStats(mk(500));
  assert.ok(small.z > 0 && big.z > 0);
  assert.ok(big.z > small.z, 'the same miss over ten times the sample is far more significant');
});
test('the flat return is computed at the price actually available', () => {
  const s = hz.zoneStats([
    { pMarket: 0.5, won: true, odds: 2.5 },
    { pMarket: 0.5, won: false, odds: 2.5 },
  ]);
  assert.ok(close(s.flatReturn, 0.25), String(s.flatReturn));
});
test('an unusable observation is dropped, never coerced', () => {
  // Number(null) is 0 and 0 is finite; a pMarket of 0 would be a certainty.
  const s = hz.zoneStats([
    { pMarket: null, won: true, odds: 2 }, { pMarket: 0, won: true, odds: 2 },
    { pMarket: 1, won: true, odds: 2 }, { pMarket: 0.5, won: null, odds: 2 },
    { pMarket: 0.5, won: true, odds: 2 },
  ]);
  assert.strictEqual(s.n, 1);
});
test('an empty zone reports nothing rather than zero', () => {
  const s = hz.zoneStats([]);
  assert.deepStrictEqual({ n: s.n, expected: s.expected, z: s.z }, { n: 0, expected: null, z: null });
});

console.log('the market side comes from a SHIN de-vig of the whole vector');
const tick = (h, d, a, over = {}) => ({
  matchId: 'm1', capturedAt: '2026-08-27T20:30:00Z', minute: 60,
  goalsHome: 1, goalsAway: 0,
  legs: { home: { best_odds: h }, draw: { best_odds: d }, away: { best_odds: a } },
  ...over,
});
test('the three probabilities sum to one and sit under their implied prices', () => {
  const p = hz.marketProbs(tick(1.80, 3.60, 4.50));
  assert.ok(close(p.home + p.draw + p.away, 1, 1e-6));
  // the difference between implied and de-vigged IS the margin being removed
  assert.ok(p.home < 1 / 1.80, `${p.home} must be under ${1 / 1.80}`);
  assert.ok(p.away < 1 / 4.50);
});
test('a vector missing a leg is refused, not de-vigged as two', () => {
  assert.strictEqual(hz.marketProbs(tick(1.80, null, 4.50)), null);
  assert.strictEqual(hz.marketProbs(tick(1.80, 3.60, 0)), null);
});
test('pivotTicks drops a tick that cannot be de-vigged whole', () => {
  const rows = [
    { match_id: 'm1', captured_at: 't1', selection: 'home', market: 'h2h', best_odds: 1.8 },
    { match_id: 'm1', captured_at: 't1', selection: 'draw', market: 'h2h', best_odds: 3.6 },
    // no away leg
    { match_id: 'm1', captured_at: 't2', selection: 'home', market: 'h2h', best_odds: 1.8 },
    { match_id: 'm1', captured_at: 't2', selection: 'draw', market: 'h2h', best_odds: 3.6 },
    { match_id: 'm1', captured_at: 't2', selection: 'away', market: 'h2h', best_odds: 4.5 },
  ];
  const ticks = hz.pivotTicks(rows);
  assert.strictEqual(ticks.length, 1);
  assert.strictEqual(ticks[0].capturedAt, 't2');
});
test('a totals row never enters the 1X2 vector', () => {
  // `odds` carries three markets in one column shape — home_odds is the Over
  // price on a totals row, which would inflate the home leg silently.
  const rows = [
    { match_id: 'm1', captured_at: 't1', selection: 'home', market: 'totals', best_odds: 9.9 },
    { match_id: 'm1', captured_at: 't1', selection: 'home', market: 'h2h', best_odds: 1.8 },
    { match_id: 'm1', captured_at: 't1', selection: 'draw', market: 'h2h', best_odds: 3.6 },
    { match_id: 'm1', captured_at: 't1', selection: 'away', market: 'h2h', best_odds: 4.5 },
  ];
  assert.strictEqual(hz.pivotTicks(rows)[0].legs.home.best_odds, 1.8);
});

console.log('THE ORIENTATION — the failure that is invisible in a results table');
const MOM = {
  minute: 60, goals_home: 0, goals_away: 1,
  xg_home: 2.4, xg_away: 0.4, sot_home: 7, sot_away: 2,
  shots_home: 18, shots_away: 4, inside_home: 12, inside_away: 3,
  corners_home: 9, corners_away: 1, poss_home: 68, poss_away: 32,
  reds_home: 0, reds_away: 1,
};
test('every differential flips with the side', () => {
  const h = hz.orientFeatures(MOM, 'home');
  const a = hz.orientFeatures(MOM, 'away');
  for (const k of ['xgDiff', 'sotDiff', 'shotsDiff', 'insideDiff', 'cornersDiff', 'possDiff', 'goalDiff', 'redDiff']) {
    assert.ok(close(h[k], -a[k]), `${k}: home ${h[k]} vs away ${a[k]} must be opposite`);
  }
});
test('the home side of this fixture is dominating and LOSING', () => {
  const h = hz.orientFeatures(MOM, 'home');
  assert.ok(close(h.xgDiff, 2.0), String(h.xgDiff));
  assert.ok(close(h.goalDiff, -1), String(h.goalDiff));
  // creating two goals more than it has scored, on a scoreboard one behind
  assert.ok(close(h.xgSurplus, 3.0), String(h.xgSurplus));
});
test('and the away side reads as the one hanging on', () => {
  const a = hz.orientFeatures(MOM, 'away');
  assert.ok(close(a.xgSurplus, -3.0), String(a.xgSurplus));
  assert.ok(a.possDiff < 0 && a.goalDiff > 0);
});
test('the draw has no side and gets no features', () => {
  assert.strictEqual(hz.orientFeatures(MOM, 'draw'), null);
});
test('an unknown statistic stays null — Number(null) is 0 and 0 is finite', () => {
  // Both callers were written with a bare coercion and both were caught here:
  // an absent xG differenced against a real one gave -0.4 rather than null,
  // which would teach the study that untracked competitions create nothing.
  const f = hz.orientFeatures({ ...MOM, xg_home: null }, 'home');
  assert.strictEqual(f.xgDiff, null);
  assert.strictEqual(f.xgSurplus, null, 'and does not become the goal difference');
  assert.ok(Number.isFinite(f.sotDiff), 'while the statistics that ARE reported survive');
});
test('the scoreline falls back to the tick when the state row lacks it', () => {
  const f = hz.orientFeatures({ ...MOM, goals_home: null, goals_away: null }, 'home',
    { goalsHome: 3, goalsAway: 0, minute: 70 });
  assert.ok(close(f.goalDiff, 3));
});

console.log('winning, and the join');
test('didWin reads the final score from the right side', () => {
  assert.strictEqual(hz.didWin('home', 2, 1), true);
  assert.strictEqual(hz.didWin('away', 2, 1), false);
  assert.strictEqual(hz.didWin('draw', 1, 1), true);
  assert.strictEqual(hz.didWin('home', 1, 1), false);
});
test('an unplayed match is null, never a loss — the same coercion, worse', () => {
  // Number(null) is 0, so 0 > 0 read as a LOSS on every unfinished match.
  assert.strictEqual(hz.didWin('home', null, null), null);
  assert.strictEqual(hz.didWin('home', undefined, 1), null);
});
test('the nearest state within tolerance is taken, and nothing beyond it', () => {
  const rows = [
    { captured_at: '2026-08-27T20:00:00Z', tag: 'far' },
    { captured_at: '2026-08-27T20:29:30Z', tag: 'near' },
  ];
  assert.strictEqual(hz.nearestMomentum(rows, '2026-08-27T20:30:00Z').tag, 'near');
  assert.strictEqual(hz.nearestMomentum(rows, '2026-08-27T21:00:00Z'), null,
    'state from a different phase of the match must not be paired with a tick');
});

console.log('ONE OBSERVATION PER MATCH — 40 ticks are not 40 observations');
const obsAt = (matchId, selection, minute, xgSurplus, extra = {}) => ({
  matchId, selection, kickoffAt: '2026-08-27T19:00:00Z',
  pMarket: 0.4, odds: 2.6, won: true,
  features: { minute, xgSurplus, goalDiff: -1, sotDiff: 5, possDiff: 25, cornersDiff: 5 },
  ...extra,
});
const H = hz.HYPOTHESES.find(h => h.key === 'xg_surplus');
test('a match in the zone for twenty ticks contributes one', () => {
  const stream = Array.from({ length: 20 }, (_, i) => obsAt('m1', 'home', 40 + i, 1.5));
  assert.strictEqual(hz.firstEntryPerMatch(stream, H).length, 1);
});
test('and it is the FIRST entry — the only tick anyone could have acted on', () => {
  const stream = [obsAt('m1', 'home', 35, 1.5), obsAt('m1', 'home', 60, 3.0)];
  assert.strictEqual(hz.firstEntryPerMatch(stream, H)[0].features.minute, 35);
});
test('the two sides of one match are separate observations', () => {
  const stream = [obsAt('m1', 'home', 40, 1.5), obsAt('m1', 'away', 40, 1.5)];
  assert.strictEqual(hz.firstEntryPerMatch(stream, H).length, 2);
});
test('a tick with no state cannot enter any zone', () => {
  const stream = [{ ...obsAt('m1', 'home', 40, 1.5), features: null }];
  assert.strictEqual(hz.firstEntryPerMatch(stream, H).length, 0);
});
test('the minute window is enforced — a 20th-minute reading is not a signal', () => {
  assert.strictEqual(hz.firstEntryPerMatch([obsAt('m1', 'home', 20, 3.0)], H).length, 0);
  assert.strictEqual(hz.firstEntryPerMatch([obsAt('m1', 'home', 85, 3.0)], H).length, 0);
});

console.log('the holdout is split by KICKOFF, not at random');
test('a match lands wholly on one side of the split', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    for (let t = 0; t < 5; t++) {
      rows.push({ matchId: `m${i}`, selection: 'home', pMarket: 0.5, odds: 2, won: true,
                  kickoffAt: new Date(Date.UTC(2026, 7, 20 + i)).toISOString() });
    }
  }
  const { explore, holdout, exploreMatches, holdoutMatches } = hz.splitByTime(rows, 0.5);
  assert.strictEqual(exploreMatches, 5);
  assert.strictEqual(holdoutMatches, 5);
  const eIds = new Set(explore.map(o => o.matchId));
  const hIds = new Set(holdout.map(o => o.matchId));
  for (const id of eIds) {
    assert.ok(!hIds.has(id), `${id} leaked across the split — a random split does exactly this`);
  }
});
test('the holdout is the LATER matches, which is what a forward test means', () => {
  const rows = ['2026-08-20', '2026-08-25'].flatMap((d, i) =>
    [{ matchId: `m${i}`, selection: 'home', pMarket: 0.5, odds: 2, won: true, kickoffAt: `${d}T19:00:00Z` }]);
  const { holdout } = hz.splitByTime(rows, 0.5);
  assert.strictEqual(holdout[0].matchId, 'm1');
});

console.log('the hypotheses are pre-registered and the near-null is deliberate');
test('the list is frozen — adding one after seeing the data raises the bar for all', () => {
  assert.ok(Object.isFrozen(hz.HYPOTHESES));
  assert.ok(hz.HYPOTHESES.length >= 3 && hz.HYPOTHESES.length <= 8,
    'few enough that the corrected bar stays reachable');
  for (const h of hz.HYPOTHESES) {
    assert.ok(h.key && h.label && h.why && typeof h.enter === 'function',
      `${h.key}: every hypothesis must say what it is and why`);
  }
});
test('one of them is expected to find NOTHING, and says so', () => {
  const nulls = hz.HYPOTHESES.filter(h => /near-null/.test(h.why));
  assert.strictEqual(nulls.length, 1,
    'a study with no expected-null has no way to show its bar is honest');
});
test('the sharper form of a hypothesis is a strict subset of the looser one', () => {
  const loose = hz.HYPOTHESES.find(h => h.key === 'xg_surplus');
  const sharp = hz.HYPOTHESES.find(h => h.key === 'xg_surplus_behind');
  const f = { minute: 60, xgSurplus: 1.5, goalDiff: -1, sotDiff: 5, possDiff: 25, cornersDiff: 5 };
  assert.strictEqual(sharp.enter(f) && loose.enter(f), true);
  const ahead = { ...f, goalDiff: 1 };
  assert.strictEqual(sharp.enter(ahead), false);
  assert.strictEqual(loose.enter(ahead), true);
});

console.log('the control curve');
test('a calibrated market produces a flat curve near zero', () => {
  const obs = [];
  for (const p of [0.25, 0.55, 0.85]) {
    for (let i = 0; i < 200; i++) obs.push({ pMarket: p, won: i < 200 * p, odds: 1 / p });
  }
  const bands = hz.calibrationCurve(obs).filter(b => b.n);
  assert.ok(bands.length >= 3);
  for (const b of bands) assert.ok(Math.abs(b.z) < 1, `band ${b.lo}: z ${b.z}`);
});
test('an INVERTED join shows up loudly here, which is the whole point', () => {
  // Every away leg flipped: the market looks catastrophically wrong.
  const obs = [];
  for (let i = 0; i < 300; i++) obs.push({ pMarket: 0.8, won: i < 60, odds: 1.25 });
  const worst = Math.max(...hz.calibrationCurve(obs).filter(b => b.n).map(b => Math.abs(b.z)));
  assert.ok(worst > 5, `a broken join must be unmissable, got |z| ${worst}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
