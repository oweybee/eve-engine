'use strict';

/**
 * engine.inplaystate.test.js — live match state, and the ONE thing it is
 * allowed to move.
 *
 * The model priced (score, minute, frozen lambda) and nothing else, while
 * fetchLiveStats.js wrote 18 statistics per side that nothing in the signal
 * path read. These pin what changed and — more importantly — what did not:
 * possession and shots are carried and logged and move no number, because
 * this repo has no measurement for what they are worth in goals.
 *
 * Run: node engine.inplaystate.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const st = require('./lib/inplayState');
const { sniperCandidates } = require('./lib/secondHalfSniper');
const { winProbCandidates } = require('./computeInplayValues');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const side = (over = {}) => ({
  stats: [
    { type: 'Red Cards',       value: over.reds ?? null },
    { type: 'Total Shots',     value: over.shots ?? 8 },
    { type: 'Shots on Goal',   value: over.on ?? 3 },
    { type: 'Ball Possession', value: over.poss ?? '50%' },
  ],
});

console.log('statValue — reported-zero vs not-reported-at-all');
test('a NULL value is a reported zero, not an absence', () => {
  assert.strictEqual(st.statValue(side({ reds: null }).stats, 'Red Cards'), 0);
});
test('an absent type is null, and the two are different facts', () => {
  assert.strictEqual(st.statValue([{ type: 'Total Shots', value: 4 }], 'Red Cards'), null);
});
test('a percentage string parses to its number', () => {
  assert.strictEqual(st.statValue(side({ poss: '61%' }).stats, 'Ball Possession'), 61);
});
test('junk and a missing array are null, never 0', () => {
  assert.strictEqual(st.statValue([{ type: 'Red Cards', value: 'n/a' }], 'Red Cards'), null);
  assert.strictEqual(st.statValue(null, 'Red Cards'), null);
  assert.strictEqual(st.statValue(undefined, 'Red Cards'), null);
});

console.log('adjustLambdaForCards — the measured multipliers');
const L = { lambdaHome: 1.40, lambdaAway: 1.20 };
test('even sides leave lambda EXACTLY as the baseline froze it', () => {
  const a = st.adjustLambdaForCards(L, st.liveState(side({ reds: 0 }), side({ reds: 0 })));
  assert.strictEqual(a.applied, false);
  assert.strictEqual(a.lambdaHome, 1.40);
  assert.strictEqual(a.lambdaAway, 1.20);
});
test('the ten-man side is shortened and the eleven-man side lengthened', () => {
  const a = st.adjustLambdaForCards(L, st.liveState(side({ reds: 1 }), side({ reds: 0 })));
  assert.strictEqual(a.applied, true);
  assert.ok(Math.abs(a.lambdaHome - 1.40 * st.RED_CARD_LAMBDA.short) < 1e-9);
  assert.ok(Math.abs(a.lambdaAway - 1.20 * st.RED_CARD_LAMBDA.full) < 1e-9);
});
test('and it is symmetric the other way', () => {
  const a = st.adjustLambdaForCards(L, st.liveState(side({ reds: 0 }), side({ reds: 1 })));
  assert.ok(Math.abs(a.lambdaHome - 1.40 * st.RED_CARD_LAMBDA.full) < 1e-9);
  assert.ok(Math.abs(a.lambdaAway - 1.20 * st.RED_CARD_LAMBDA.short) < 1e-9);
});
test('the direction matches the measurement: short DOWN, full UP', () => {
  assert.ok(st.RED_CARD_LAMBDA.short < 1, 'a ten-man side scores less');
  assert.ok(st.RED_CARD_LAMBDA.full  > 1, 'an eleven-man side scores more');
});
test('a card RAISES the expected TOTAL, which is what the record shows', () => {
  const a = st.adjustLambdaForCards(L, st.liveState(side({ reds: 1 }), side({ reds: 0 })));
  assert.ok(a.lambdaHome + a.lambdaAway > L.lambdaHome + L.lambdaAway,
    'x1.6018 on one side outweighs x0.6178 on the other');
});

console.log('adjustLambdaForCards — failing closed');
test('NO stats row leaves lambda untouched (the behaviour before this existed)', () => {
  for (const absent of [null, undefined, {}]) {
    const a = st.adjustLambdaForCards(L, absent);
    assert.strictEqual(a.applied, false);
    assert.strictEqual(a.lambdaHome, 1.40);
  }
});
test('a feed that does not REPORT cards leaves lambda untouched', () => {
  // Both sides present, Red Cards absent from the payload entirely.
  const noCardField = { stats: [{ type: 'Total Shots', value: 9 }] };
  const a = st.adjustLambdaForCards(L, st.liveState(noCardField, noCardField));
  assert.strictEqual(a.applied, false);
});
test('a non-finite lambda is returned unchanged rather than becoming NaN', () => {
  const a = st.adjustLambdaForCards({ lambdaHome: null, lambdaAway: 1.2 },
    st.liveState(side({ reds: 1 }), side({ reds: 0 })));
  assert.strictEqual(a.applied, false);
});
test('a two-card advantage is priced AS ONE — never compounded past the evidence', () => {
  const one = st.adjustLambdaForCards(L, st.liveState(side({ reds: 1 }), side({ reds: 0 })));
  const two = st.adjustLambdaForCards(L, st.liveState(side({ reds: 3 }), side({ reds: 0 })));
  assert.strictEqual(two.lambdaHome, one.lambdaHome);
  assert.strictEqual(two.lambdaAway, one.lambdaAway);
  assert.strictEqual(two.differential, 3, 'the raw differential is still reported honestly');
});

console.log('what live state must NOT do');
test('possession and shots move NO number', () => {
  const quiet = st.liveState(side({ poss: '20%', shots: 1,  on: 0, reds: 0 }),
                             side({ poss: '80%', shots: 25, on: 12, reds: 0 }));
  const a = st.adjustLambdaForCards(L, quiet);
  assert.strictEqual(a.applied, false, 'a 25-1 shot count is not evidence this repo has measured');
  assert.strictEqual(a.lambdaHome, 1.40);
  assert.strictEqual(a.lambdaAway, 1.20);
});
test('but they ARE carried, so the reader and the model see one object', () => {
  const s = st.liveState(side({ poss: '61%', shots: 11, on: 3 }), side({ shots: 7, on: 3 }));
  assert.strictEqual(s.possessionHome, 61);
  assert.strictEqual(s.shotsHome, 11);
  assert.strictEqual(s.shotsAway, 7);
  assert.ok(/poss 61%/.test(st.describeState(s, { applied: false })));
});

console.log('end to end — a sending-off changes the signal');
// KICKOFF IS RELATIVE TO NOW. The win-prob stage refuses to price against a
// clock that disagrees with the wall clock, so a fixture pinned to a date in
// the past is a permanently stale one and every case below would be empty.
// 77 minutes ago at the 60th is the half-time break plus two of delay.
const liveH2h = odds => ({
  id: 'm1',
  kickoff_at: new Date(Date.now() - 77 * 60_000).toISOString(),
  minute: 60,
  goals_home: 0, goals_away: 0, home_team: { name: 'A' }, away_team: { name: 'B' },
  odds: [{ market: 'h2h', bookmaker: 'live', home_odds: odds[0], draw_odds: odds[1], away_odds: odds[2] }],
});
const baseline = { lambda_home: 1.5, lambda_away: 1.2 };

test('a sending-off turns a NON-signal into a signal, at a real price', () => {
  // 0-0 at minute 60, lambda 1.5/1.2, a market of 2.20 / 3.20 / 4.00
  // (overround 1.017 — a vector summing under one is an arbitrage the de-vig
  // refuses, so a fixture must not use one).
  //
  //   even sides   home 0.2887  ->  edge at 2.20 = -36.5%   nothing fires
  //   away to ten  home 0.4685  ->  edge at 2.20 =  +3.1%   home fires
  //
  // This is the whole point of the change in one assertion: the model could
  // not see the card, so it would have gone on pricing home at 28.9% and
  // published nothing while the market repriced without it.
  const m = liveH2h([2.20, 3.20, 4.00]);
  const even = winProbCandidates(m, baseline, {});
  const awayOff = winProbCandidates(m, baseline, {
    liveState: st.liveState(side({ reds: 0 }), side({ reds: 1 })),
  });
  assert.strictEqual(even.length, 0, 'nothing qualifies with eleven a side');
  assert.strictEqual(awayOff.length, 1);
  assert.strictEqual(awayOff[0].outcome, 'home');
  assert.ok(awayOff[0].detected_edge > 0.02 && awayOff[0].detected_edge < 0.20,
    `edge ${awayOff[0].detected_edge} must be inside the band`);
  assert.ok(awayOff[0].detected_odds < 3.00, 'and inside the price ceiling');
});

test('and the reverse card moves it the other way — direction, not magnitude', () => {
  const m = liveH2h([2.20, 3.20, 4.00]);
  // Every gate wide open, so this compares the LAMBDA and not the filters.
  const wide = { maxOdds: 99, maxEdge: 99, evThreshold: -99 };
  const homeOff = winProbCandidates(m, baseline, {
    ...wide, liveState: st.liveState(side({ reds: 1 }), side({ reds: 0 })),
  });
  const even = winProbCandidates(m, baseline, wide);
  const edgeOf = (o, k) => o.find(c => c.outcome === k)?.detected_edge;
  assert.ok(edgeOf(homeOff, 'home') < edgeOf(even, 'home'), 'home shortens when home is sent off');
  assert.ok(edgeOf(homeOff, 'away') > edgeOf(even, 'away'), 'away lengthens');
});

test('the sniper prices it too, through the same multipliers', () => {
  const totals = {
    id: 'm2', kickoff_at: '2026-08-26T16:45:00Z', minute: 45,
    goals_home: 0, goals_away: 0, home_team: { name: 'A' }, away_team: { name: 'B' },
    odds: [{ market: 'totals', market_line: 1.5, bookmaker: 'live', home_odds: 2.60, away_odds: 1.50 }],
  };
  const opts = { evThreshold: 0.02, maxEdge: 0.20 };
  const even = sniperCandidates(totals, { lambda_home: 1.6, lambda_away: 1.3 }, opts);
  const card = sniperCandidates(totals, { lambda_home: 1.6, lambda_away: 1.3 },
    { ...opts, liveState: st.liveState(side({ reds: 1 }), side({ reds: 0 })) });
  // A card raises the expected total, so the Over's edge cannot fall.
  const e = even[0]?.detected_edge ?? 0;
  const c = card[0]?.detected_edge ?? 0;
  assert.ok(c >= e, `Over edge must not fall on a red card: ${e} -> ${c}`);
});

test('an unreported card leaves BOTH stages exactly where they were', () => {
  const m = liveH2h([2.60, 2.10, 5.00]);
  assert.deepStrictEqual(
    winProbCandidates(m, baseline, { maxOdds: 99 }).map(c => c.detected_edge),
    winProbCandidates(m, baseline, { maxOdds: 99, liveState: null }).map(c => c.detected_edge),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
