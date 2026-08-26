'use strict';

/**
 * engine.inplay.test.js — unit tests for the in-play pipeline's pure logic.
 * Run: node engine.inplay.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const inplay = require('./lib/inplay');
const { buildMessage, isInplay, isSuggested, isBroadcastable, bandOf, chatIdForSignal } = require('./postToX');
const { classifyTier, dedupeConflicts, bandFor, isBacked } = require('./lib/signalTier');
const { scoreSignal } = require('./lib/maxedge');
const { extractLiveH2h } = require('./ingestLiveOdds');
const elo = require('./lib/elo');
const { buildLadder } = require('./computeElo');
const { buildHalftimeVector, leagueKey, formRates, FEATURE_ORDER,
        buildPrematchVector, prematchLeagueKey, PREMATCH_FEATURE_ORDER } = require('./lib/halftimeFeatures');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const KO = Date.UTC(2026, 5, 30, 18, 0, 0); // kickoff

console.log('classifyPhase');
test('before kickoff → prematch', () => assert.strictEqual(inplay.classifyPhase(KO - 1000, KO), 'prematch'));
test('at kickoff → inplay',       () => assert.strictEqual(inplay.classifyPhase(KO, KO), 'inplay'));
test('after kickoff → inplay',    () => assert.strictEqual(inplay.classifyPhase(KO + 60000, KO), 'inplay'));
test('no kickoff → prematch',     () => assert.strictEqual(inplay.classifyPhase(KO, NaN), 'prematch'));

console.log('isWithinLiveWindow');
test('just after kickoff is live', () => assert.ok(inplay.isWithinLiveWindow(KO, KO + 60_000)));
test('before kickoff not live',    () => assert.ok(!inplay.isWithinLiveWindow(KO, KO - 1000)));
test('past the window not live',   () => assert.ok(!inplay.isWithinLiveWindow(KO, KO + inplay.LIVE_WINDOW_MS + 1)));

console.log('inplayEdge');
test('EV = p*odds - 1',            () => assert.ok(Math.abs(inplay.inplayEdge(0.5, 3.0) - 0.5) < 1e-9));
test('positive when model > implied', () => assert.ok(inplay.inplayEdge(0.4, 3.0) > 0));
test('negative when model < implied', () => assert.ok(inplay.inplayEdge(0.2, 3.0) < 0));
test('null on odds <= 1',          () => assert.strictEqual(inplay.inplayEdge(0.5, 1.0), null));
test('null on bad prob',           () => assert.strictEqual(inplay.inplayEdge(0, 3.0), null));
test('null on prob > 1',           () => assert.strictEqual(inplay.inplayEdge(1.2, 3.0), null));

console.log('marginBuckets');
test('one goal down → ht_losing_1', () => assert.strictEqual(inplay.marginBuckets(-1).ht_losing_1, 1));
test('two down → ht_losing_2plus',  () => assert.strictEqual(inplay.marginBuckets(-2).ht_losing_2plus, 1));
test('level → ht_draw',             () => assert.strictEqual(inplay.marginBuckets(0).ht_draw, 1));
test('exactly one bucket hot',      () => {
  const b = inplay.marginBuckets(-1);
  assert.strictEqual(Object.values(b).reduce((s, x) => s + x, 0), 1);
});

console.log('bestH2hOdds');
test('picks best price per outcome, single source ok', () => {
  const rows = [
    { bookmaker: 'a', market: 'h2h', home_odds: 4.0, draw_odds: 3.5, away_odds: 1.8 },
    { bookmaker: 'b', market: 'h2h', home_odds: 4.2, draw_odds: 3.4, away_odds: 1.75 },
  ];
  const best = inplay.bestH2hOdds(rows);
  assert.strictEqual(best.home.odds, 4.2);
  assert.strictEqual(best.home.book, 'b');
  assert.strictEqual(best.away.odds, 1.8);
});
test('ignores non-h2h and junk prices', () => {
  const rows = [
    { bookmaker: 'x', market: 'totals', home_odds: 9.9, draw_odds: null, away_odds: 1.1 },
    { bookmaker: 'y', market: 'h2h',    home_odds: 1.0, draw_odds: 3.0,  away_odds: 2.0 },
  ];
  const best = inplay.bestH2hOdds(rows);
  assert.strictEqual(best.home, null);   // 1.0 rejected, totals ignored
  assert.strictEqual(best.draw.odds, 3.0);
});

console.log('formatLiveState');
test('renders score + minute', () => assert.strictEqual(inplay.formatLiveState(1, 0, 38), "1-0 38'"));
test('handles missing minute',  () => assert.strictEqual(inplay.formatLiveState(2, 2, null), '2-2'));

console.log('postToX routing + message');
const inplaySignal = {
  phase: 'inplay', outcome: 'home', detected_odds: 4.0, detected_edge: 0.12,
  detected_mes: null, bookmaker: 'apifootball_live',
  match: { goals_home: 0, goals_away: 1, minute: 40,
           home_team: { name: 'Brazil' }, away_team: { name: 'Japan' }, league: { name: 'World Cup' } },
};
// EDGE MOVED 3% -> 2.5% (22 Aug 2026). The floor of the eligibility box came
// down from 4% to 3% to meet `f(edge)`'s plateau, so 3% is now exactly ON the
// line and IS suggested. This fixture's whole job is to be an unbacked row, so
// it has to sit below whatever the floor is; the boundary itself is pinned
// separately, right under this test, so a future move of the floor fails there
// with the reason attached rather than quietly re-purposing this fixture.
const prematchSignal = {
  phase: 'prematch', outcome: 'away', detected_odds: 2.5, detected_edge: 0.025,
  detected_mes: 60, bookmaker: 'Bet365', kickoff_at: new Date(KO).toISOString(),
  signal_category: 'value',
  match: { home_team: { name: 'A' }, away_team: { name: 'B' }, league: { name: 'L' } },
};
test('isInplay true for inplay phase', () => assert.ok(isInplay(inplaySignal)));
test('in-play message has live header + score', () => {
  const m = buildMessage(inplaySignal);
  assert.ok(m.includes('IN-PLAY VALUE'), 'header');
  assert.ok(m.includes('Live: 0-1 40\''), 'live score');
  assert.ok(m.includes('#InPlay'), 'hashtag');
});
test('prematch unbacked edge (odds 2.5 / edge 2.5%) → info-only header, not suggested', () => {
  // Header renamed from "VALUE SIGNAL" on 6 Aug 2026: VALUE was a word of the
  // retired conviction ladder, and this row is not a conviction at all — it is
  // positive EV outside the band we back at.
  const m = buildMessage(prematchSignal);
  assert.ok(m.includes('UNBACKED EDGE'));
  assert.ok(m.includes('not a suggested selection'));
  assert.ok(m.includes('Kickoff:'));
  assert.ok(!m.includes('IN-PLAY'));
  assert.strictEqual(isSuggested(prematchSignal), false);
});

// THE FLOOR IS 3% AND IT IS INCLUSIVE — the boundary itself, pinned.
//
// It was 4% until 22 Aug 2026, and the day the plateau moved to 3% without it
// the two ladders disagreed in [3%, 4%): the score kept its full value (f = 1
// on the plateau) while this box declined the row, and the homepage drew
// `◆ PRIME · 65` under a header reading NOTHING BACKED TODAY. They read ONE
// constant now — `EDGE_EFFICIENCY.plateauFrom` is `THRESHOLDS.PRIME_EDGE_MIN`
// — so this asserts the number the whole product turns on.
test('the eligibility box admits 3% and refuses just under it', () => {
  const at = (edge) => isSuggested({ ...prematchSignal, detected_edge: edge });
  assert.strictEqual(at(0.03), true, '3% is ON the floor and suggested');
  assert.strictEqual(at(0.0299), false, 'just under the floor is not');
  assert.strictEqual(at(0.099), true, 'still open just under the 10% cap');
  assert.strictEqual(at(0.10), false, 'and closed at the cap');
});

// Tier classifier + PRIME broadcast policy -----------------------------------
//
// SINCE 6 Aug 2026 A BROADCAST NEEDS BOTH LADDERS. `PRIME SIGNAL` means what a
// ◆ PRIME badge on the site means — the eligibility ladder suggests it AND the
// conviction ladder scores it 65+ — so the word cannot say one thing in the
// channel and another on a row. A suggested selection we could not score is
// not broadcast at all.
// odds 2.2 at a 9% edge scores 76. That was STRONG under the six-rung ladder and
// is PRIME under the five-rung one (21 Aug 2026, migration 089) — the SAME 65
// line wearing a different word both times. The row is BACKED either way, and
// "backed" is the thing this file is actually about, so the fixture is named for
// that rather than for whichever word sits at the top of the ladder today.
// `market_prob` is the Shin-de-vigged panel probability the engine stores as of
// migration 058, and `gap_basis` is what says so — without it a recompute cannot
// tell this row from a pre-7-Aug one whose market_prob is a margin-carrying
// 1/odds. 0.4400 against a raw 1/2.20 = 0.4545.
const backedSignal = {
  ...prematchSignal, detected_odds: 2.2, detected_edge: 0.09,
  model_architecture: 'DIXON_COLES', mxs: 76, mxs_band: 'PRIME',
  market_prob: 0.44, gap_basis: 'devigged',
};
const longshotSignal = { ...prematchSignal, detected_odds: 5.0, detected_edge: 0.07 };

test('prime box + a backed score → BACKED header, broadcastable', () => {
  assert.strictEqual(classifyTier(backedSignal).tier, 'prime');
  assert.strictEqual(isSuggested(backedSignal), true);
  assert.strictEqual(isBroadcastable(backedSignal), true);
  const m = buildMessage(backedSignal);
  // NOT "PRIME SIGNAL", and the gate has not moved — both ladders are still
  // required. The header states what the post is gated ON rather than naming a
  // rung, and that is deliberate: the rung word has moved twice (STRONG took the
  // 65 line on 6 Aug, PRIME took it back on 21 Aug) while the gate — `isBacked`
  // — never moved at all. A header carrying the word goes stale on a re-label;
  // a header carrying the predicate cannot.
  assert.ok(m.includes('BACKED SIGNAL'), 'header');
  // The BAN IS ON THE HEADER, not on the word. `PRIME SIGNAL` was the
  // eligibility ladder's bucket key wearing a rung's clothes, and it went out
  // over rows the site badged WATCH. The NOTE may name the rung the row
  // actually earned — asserted against `bandOf` rather than a literal, so the
  // next re-label moves this test with the ladder instead of breaking it.
  assert.ok(!m.includes('PRIME SIGNAL'), 'the header states the gate, never a rung');
  assert.ok(m.includes(`(${bandOf(backedSignal)})`), 'names the rung it earned');
  assert.ok(m.includes('backed'), 'backed note');
  assert.ok(m.includes('76/100'), 'states the score it is claiming');
});

test('the rung is read from the row, and recomputed when it is absent', () => {
  // A backfilled or legacy row carries no mxs_band; the same formula fills it
  // in rather than silently making the signal unbroadcastable.
  const { mxs, mxs_band, ...unstored } = backedSignal;
  // Asserted through the classifier, not against a literal word. Pinning 'PRIME'
  // here is what broke when the ladder was re-cut: the recomputed rung moved to
  // STRONG while the row's meaning — suggested, and backed — did not change.
  assert.strictEqual(bandOf(unstored), bandFor(scoreSignal(unstored).mxs));
  assert.strictEqual(isBacked(scoreSignal(unstored).mxs), true);
  assert.strictEqual(isBroadcastable(unstored), true);
});

test('THE BOX AND THE RUNG DO NOT COINCIDE, and that is the point', () => {
  // odds 2.2 at a 6% edge is well inside the eligibility ladder's profitable
  // box, and it scores 62 — WATCH. Measured against production on 6 Aug 2026,
  // 4 of the 10 published prematch signals in the box clear MXS 65; the other
  // 6 do not. Under the old policy all 10 were broadcast as "PRIME SIGNAL"
  // while the site badged six of them WATCH. Requiring both is what stops the
  // word meaning two things, and a quieter channel is the cost of that.
  // Scored against the de-vigged 0.4400 rather than 1/2.20, this is 83 — BACKED.
  // Under the old convention the same row scored 62 and was withheld.
  // That is the change working: the margin was hiding a real disagreement, and 7
  // of the live board's selections move across the line the same way. The pair
  // still does not coincide — the point of the test — it just no longer needs a
  // row this strong to make it.
  const inBox = { ...backedSignal, detected_edge: 0.06 };
  delete inBox.mxs; delete inBox.mxs_band;
  assert.strictEqual(classifyTier(inBox).suggested, true, 'the box suggests it');
  // THROUGH `isBacked`, NOT AGAINST A LITERAL. The test two above says exactly
  // this — "pinning 'PRIME' here is what broke when the ladder was re-cut" — and
  // this line was still pinning 'STRONG', so the 21 Aug re-label broke it. The
  // claim is that the de-vigged score BACKS the row; the word is incidental.
  assert.strictEqual(isBacked(scoreSignal(inBox).mxs), true, 'the de-vigged score backs it');
  assert.strictEqual(isBroadcastable(inBox), true);

  // The divergence itself, which needs a LONGER price than it used to. At 2.20
  // against a de-vigged 0.44 the whole 4–10% box now clears 65, so the two
  // ladders agree there; they part company further out, where the same edge is a
  // smaller probability disagreement. 2.80 at 4.5% scores 63 — WATCH — and is
  // suggested. That asymmetry is §6.2's argument for leading with the gap
  // instead of the edge, and de-vigging sharpened it rather than removing it.
  const thin = { ...backedSignal, detected_odds: 2.8, detected_edge: 0.045, market_prob: 0.345 };
  delete thin.mxs; delete thin.mxs_band;
  assert.strictEqual(classifyTier(thin).suggested, true, 'the box suggests it');
  assert.strictEqual(bandOf(thin), 'WATCH', 'the score does not back it');
  assert.strictEqual(isBroadcastable(thin), false);
});

test('a legacy row is never re-scored under the new convention', () => {
  // gap_basis='implied' means market_prob is 1/detected_odds, margin included.
  // Both conventions store a finite probability in (0,1), so nothing about the
  // number itself distinguishes them — only this flag does. Re-scoring such a
  // row would mix two measurements in one broadcast gate.
  const legacy = { ...backedSignal, market_prob: 1 / 2.2, gap_basis: 'implied' };
  delete legacy.mxs; delete legacy.mxs_band;
  assert.strictEqual(bandOf(legacy), null);
  assert.strictEqual(isBroadcastable(legacy), false);
});

test('suggested but scored below the backing line is NOT broadcast', () => {
  // This is the case the old policy got wrong: the ladder suggests it, so the
  // channel would have opened with "PRIME SIGNAL" while the site badged WATCH.
  const watch = { ...backedSignal, mxs: 52, mxs_band: 'WATCH' };
  assert.strictEqual(isSuggested(watch), true);
  assert.strictEqual(isBroadcastable(watch), false);
});

test('suggested but UNSCORABLE is not broadcast either', () => {
  // An architecture with no row in model_calibration scores null, and null is
  // not PRIME. Silence is the right output for "we could not measure this".
  const unscored = { ...backedSignal, model_architecture: 'SUPERMODEL_HALFTIME' };
  delete unscored.mxs; delete unscored.mxs_band;
  assert.strictEqual(bandOf(unscored), null);
  assert.strictEqual(isBroadcastable(unscored), false);
});
test('longshot (odds ≥ 3.0) → LONGSHOT header, notable 6–10% flag, never suggested', () => {
  const c = classifyTier(longshotSignal);
  assert.strictEqual(c.tier, 'longshot');
  assert.strictEqual(c.notable, true);
  assert.strictEqual(isSuggested(longshotSignal), false);
  assert.ok(buildMessage(longshotSignal).includes('LONGSHOT · NOTABLE EDGE'));
});
test('classifier boundaries: 3.00 odds is a longshot, edge <2% hidden, ≥10% not prime', () => {
  assert.strictEqual(classifyTier({ odds: 3.0, edge: 0.06 }).tier, 'longshot');
  assert.strictEqual(classifyTier({ odds: 2.0, edge: 0.015 }).tier, null);
  assert.strictEqual(classifyTier({ odds: 2.0, edge: 0.12 }).tier, 'value');
  assert.strictEqual(classifyTier({ odds: 1.4, edge: 0.04 }).tier, 'prime');
});
test('dedupeConflicts keeps the highest-edge pick per match/market (no home+away wash)', () => {
  const rows = [
    { match_id: 'PORvCRO', market: 'h2h', outcome: 'home', detected_edge: 0.05 },
    { match_id: 'PORvCRO', market: 'h2h', outcome: 'away', detected_edge: 0.08 },
    { match_id: 'PORvCRO', market: 'totals', market_line: 2.5, outcome: 'over', detected_edge: 0.06 },
    { match_id: 'OTHER',   market: 'h2h', outcome: 'home', detected_edge: 0.04 },
  ];
  const kept = dedupeConflicts(rows);
  assert.strictEqual(kept.length, 3, 'one h2h + one totals for PORvCRO, plus OTHER');
  const por = kept.find(r => r.match_id === 'PORvCRO' && r.market === 'h2h');
  assert.strictEqual(por.outcome, 'away', 'keeps the higher-edge (away 8%) over home 5%');
  assert.ok(kept.some(r => r.market === 'totals'), 'different market survives (not a conflict)');
});
test('routes in-play to in-play channel', () =>
  assert.strictEqual(chatIdForSignal({ chatId: 'main', inplayChatId: 'live' }, inplaySignal), 'live'));
test('routes pre-match to main channel', () =>
  assert.strictEqual(chatIdForSignal({ chatId: 'main', inplayChatId: 'live' }, prematchSignal), 'main'));
test('in-play with no live channel → null (skip, no leak)', () =>
  assert.strictEqual(chatIdForSignal({ chatId: 'main', inplayChatId: null }, inplaySignal), null));

console.log('ingestLiveOdds.extractLiveH2h');
test('extracts 1X2 from live odds bet', () => {
  const bets = [{ id: 59, name: 'Fulltime Result', values: [
    { value: 'Home', odd: '4.20' }, { value: 'Draw', odd: '3.40' }, { value: 'Away', odd: '1.80' },
  ] }];
  assert.deepStrictEqual(extractLiveH2h(bets), { home: 4.2, draw: 3.4, away: 1.8 });
});
test('skips suspended selections → null', () => {
  const bets = [{ name: 'Match Winner', values: [
    { value: 'Home', odd: '4.20', suspended: true }, { value: 'Draw', odd: '3.40' }, { value: 'Away', odd: '1.80' },
  ] }];
  assert.strictEqual(extractLiveH2h(bets), null);
});
test('no match-winner bet → null', () =>
  assert.strictEqual(extractLiveH2h([{ name: 'Corners', values: [] }]), null));

console.log('lib/elo');
test('equal ratings: home favoured by home advantage', () =>
  assert.ok(elo.expectedHome(1500, 1500) > 0.5));
test('expectedHome in (0,1)', () => {
  const e = elo.expectedHome(1700, 1400);
  assert.ok(e > 0 && e < 1 && e > 0.5);
});
test('home win raises home, lowers away', () => {
  const { home, away } = elo.updatePair(1500, 1500, 'H');
  assert.ok(home > 1500 && away < 1500);
});
test('update is zero-sum', () => {
  const before = 1500 + 1500;
  const { home, away } = elo.updatePair(1500, 1500, 'A');
  assert.ok(Math.abs((home + away) - before) < 1e-9);
});
test('draw nudges favourite down, underdog up', () => {
  const { home, away } = elo.updatePair(1700, 1400, 'D'); // home was favoured
  assert.ok(home < 1700 && away > 1400);
});

console.log('computeElo.buildLadder');
test('winner ends above loser; games counted', () => {
  const matches = [
    { result: 'home', home_team: { name: 'Alpha', id: 1 }, away_team: { name: 'Beta', id: 2 } },
    { result: 'home', home_team: { name: 'Alpha', id: 1 }, away_team: { name: 'Beta', id: 2 } },
  ];
  const ladder = buildLadder(matches);
  const a = ladder.get('alpha'), b = ladder.get('beta');
  assert.ok(a.elo > 1500 && b.elo < 1500);
  assert.strictEqual(a.games, 2);
  assert.strictEqual(b.games, 2);
});
test('skips rows with no result/teams', () => {
  const ladder = buildLadder([{ result: null, home_team: { name: 'X' }, away_team: { name: 'Y' } }]);
  assert.strictEqual(ladder.size, 0);
});

console.log('lib/halftimeFeatures gating');
const goodElo = { elo: 1600, games: 12 };
const goodStats = { form: 'WWDLW', goals_for_avg: 1.8, goals_against_avg: 0.9, clean_sheet_pct: 40 };
test('leagueKey maps common names', () => {
  assert.strictEqual(leagueKey('English Premier League'), 'epl');
  assert.strictEqual(leagueKey('La Liga'), 'laliga');
  assert.strictEqual(leagueKey('Serie A'), 'seriea');
  assert.strictEqual(leagueKey('FIFA World Cup'), null);
});
test('formRates from WWDLW', () => {
  const r = formRates('WWDLW');
  assert.ok(Math.abs(r.win_rate - 0.6) < 1e-9);
  assert.ok(Math.abs(r.draw_rate - 0.2) < 1e-9);
});
test('unsupported league → dormant (null, with reason)', () => {
  const out = buildHalftimeVector({ league: 'FIFA World Cup', homeStats: goodStats, awayStats: goodStats,
    homeElo: goodElo, awayElo: goodElo, live: { homeGoals: 0, awayGoals: 1 } });
  assert.strictEqual(out.vector, null);
  assert.ok(/unsupported league/.test(out.reason));
});
test('cold-start ELO → dormant', () => {
  const out = buildHalftimeVector({ league: 'Premier League', homeStats: goodStats, awayStats: goodStats,
    homeElo: { elo: 1500, games: 1 }, awayElo: goodElo, live: { homeGoals: 0, awayGoals: 0 } });
  assert.strictEqual(out.vector, null);
  assert.ok(/insufficient ELO/.test(out.reason));
});
test('missing form → dormant', () => {
  const out = buildHalftimeVector({ league: 'Premier League', homeStats: { form: '' }, awayStats: goodStats,
    homeElo: goodElo, awayElo: goodElo, live: { homeGoals: 0, awayGoals: 0 } });
  assert.strictEqual(out.vector, null);
  assert.ok(/team form/.test(out.reason));
});
test('valid inputs → 32-dim vector in training order', () => {
  const out = buildHalftimeVector({ league: 'Premier League',
    homeStats: goodStats, awayStats: { form: 'LLDWD', goals_for_avg: 1.0, goals_against_avg: 1.5, clean_sheet_pct: 20 },
    homeElo: { elo: 1700, games: 30 }, awayElo: { elo: 1500, games: 30 },
    h2hHomeWinRate: 0.6, live: { homeGoals: 0, awayGoals: 1 } });
  assert.ok(Array.isArray(out.vector));
  assert.strictEqual(out.vector.length, FEATURE_ORDER.length);
  assert.strictEqual(out.vector.length, 32);
  const at = name => out.vector[FEATURE_ORDER.indexOf(name)];
  assert.strictEqual(at('elo_differential'), 200);     // 1700 - 1500
  assert.strictEqual(at('league_epl'), 1);
  assert.strictEqual(at('league_seriea'), 0);
  assert.strictEqual(at('HTHG'), 0);
  assert.strictEqual(at('HTAG'), 1);
  assert.strictEqual(at('ht_losing_1'), 1);            // home 0-1 → losing by 1
  assert.strictEqual(at('ht_draw'), 0);
  assert.ok(Math.abs(at('h2h_home_win_rate_5') - 0.6) < 1e-9);
  assert.ok(out.vector.every(Number.isFinite));
});

console.log('lib/halftimeFeatures pre-match vector (7-league)');
test('prematchLeagueKey recognises the extra leagues, HT model does not', () => {
  assert.strictEqual(prematchLeagueKey('Allsvenskan'), 'allsvenskan');
  assert.strictEqual(prematchLeagueKey('Major League Soccer'), 'mls');
  assert.strictEqual(prematchLeagueKey('Premier League'), 'epl');
  assert.strictEqual(prematchLeagueKey('FIFA World Cup'), null);
  // The half-time gate must STAY 5-league — the extras were not trained for it.
  assert.strictEqual(leagueKey('Allsvenskan'), null);
  assert.strictEqual(leagueKey('Major League Soccer'), null);
});
test('Allsvenskan → 25-dim pre-match vector with correct one-hot', () => {
  const out = buildPrematchVector({ league: 'Allsvenskan',
    homeStats: goodStats, awayStats: { form: 'LLDWD', goals_for_avg: 1.0, goals_against_avg: 1.5, clean_sheet_pct: 20 },
    homeElo: { elo: 1700, games: 30 }, awayElo: { elo: 1500, games: 30 }, h2hHomeWinRate: 0.6 });
  assert.strictEqual(out.vector.length, PREMATCH_FEATURE_ORDER.length);
  assert.strictEqual(out.vector.length, 25);
  const at = name => out.vector[PREMATCH_FEATURE_ORDER.indexOf(name)];
  assert.strictEqual(at('elo_differential'), 200);
  assert.strictEqual(at('league_allsvenskan'), 1);
  assert.strictEqual(at('league_mls'), 0);
  assert.strictEqual(at('league_epl'), 0);
  assert.ok(out.vector.every(Number.isFinite));
});
test('pre-match: unsupported league / cold ELO → dormant', () => {
  assert.strictEqual(buildPrematchVector({ league: 'FIFA World Cup', homeStats: goodStats, awayStats: goodStats,
    homeElo: goodElo, awayElo: goodElo }).vector, null);
  assert.strictEqual(buildPrematchVector({ league: 'MLS', homeStats: goodStats, awayStats: goodStats,
    homeElo: { elo: 1500, games: 1 }, awayElo: goodElo }).vector, null);
});

// ── Stage 3 price ceiling + the live odds window ─────────────────────────────
// The win-prob stage held a FROZEN pre-match lambda against a price taken from
// a 24-HOUR bucket, with no odds band of any kind. Over the 3,798 h2h ticks in
// inplay_market_series that combination priced 72.7% of everything the model
// produced above INPLAY_MAX_EDGE. lib/inplay.js carries the measurement.
console.log('in-play price ceiling + live odds window');
const { winProbCandidates } = require('./computeInplayValues');
const liveH2h = (odds) => ({
  id: 'm1', kickoff_at: '2026-07-01T16:00:00Z', minute: 60,
  goals_home: 0, goals_away: 0, home_team: { name: 'A' }, away_team: { name: 'B' },
  odds: [{ market: 'h2h', bookmaker: 'live', home_odds: odds[0], draw_odds: odds[1], away_odds: odds[2] }],
});
const lam = { lambda_home: 1.5, lambda_away: 1.2 };

test('a longshot outcome is declined on PRICE, and lifting the ceiling restores it', () => {
  // A drifted away price the frozen lambda still fancies: rejected at 3.00,
  // admitted at 99. Same row, same model, same edge — only the ceiling moved.
  // 0-0 at minute 60 with lambda 1.5/1.2: the model reads home .289 / draw .492
  // / away .219, against a REAL market carrying its margin (2.60 / 2.10 / 5.00
  // is an overround of 1.06 — a vector that sums under one is an arbitrage the
  // de-vig correctly refuses, so a fixture must not use one). Two legs clear
  // the EV band: the draw at +3.3% and the away at +9.5%. Only the draw is
  // inside the price band; the away is rejected on price alone. That is the
  // whole finding in one row.
  const m = liveH2h([2.60, 2.10, 5.00]);
  const capped = winProbCandidates(m, lam, { maxOdds: 3.00 });
  const lifted = winProbCandidates(m, lam, { maxOdds: 99 });
  assert.strictEqual(capped.length, 1, 'only the in-band leg survives');
  assert.strictEqual(capped[0].outcome, 'draw');
  assert.strictEqual(lifted.length, 2, 'the away leg clears every gate but the price');
  assert.ok(capped.every(c => c.detected_odds < 3.00));
  assert.ok(lifted.some(c => c.detected_odds >= 3.00));
});

test('the ceiling defaults to lib/inplay and is not typed here', () => {
  const m = liveH2h([2.60, 2.10, 5.00]);
  assert.deepStrictEqual(
    winProbCandidates(m, lam).map(c => c.detected_odds),
    winProbCandidates(m, lam, { maxOdds: inplay.INPLAY_MAX_ODDS }).map(c => c.detected_odds),
  );
});

test('the de-vigged market side still sees ALL THREE legs', () => {
  // The ceiling is on the CANDIDATE, never inside bestH2hOdds: that map also
  // feeds devigLiveH2h, and dropping a leg there would de-vig a two-legged
  // 1X2 vector and silently mis-state every market_prob on the row.
  // devigProbs returns NULL unless it is handed all three legs, so a non-null
  // market_prob is itself the proof the map was complete. And a de-vigged
  // probability must sit BELOW its own implied 1/odds — that difference is the
  // margin, and it is the thing being removed.
  const m = liveH2h([2.60, 2.10, 5.00]);
  const c = winProbCandidates(m, lam, { maxOdds: 99 });
  assert.ok(c.length >= 2, 'need more than one leg to check the vector');
  for (const x of c) {
    assert.ok(Number.isFinite(x.market_prob), `${x.outcome} lost its market_prob`);
    assert.ok(x.market_prob > 0 && x.market_prob < 1, 'a probability');
    assert.ok(x.market_prob < 1 / x.detected_odds,
      `${x.outcome}: de-vigged ${x.market_prob} must be under implied ${1 / x.detected_odds}`);
  }
});

test('fetchLiveMatches asks for a LIVE odds window, not the pre-match default', () => {
  // A source assertion, because the alternative is a live read that quietly
  // takes the 24-hour bucket again and looks identical from outside.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'computeInplayValues.js'), 'utf8');
  assert.ok(/oddsMaxAgeMinutes:\s*inplay\.INPLAY_ODDS_MAX_AGE_MIN/.test(src),
    'fetchLiveMatches must pass inplay.INPLAY_ODDS_MAX_AGE_MIN');
  assert.ok(inplay.INPLAY_ODDS_MAX_AGE_MIN > 0 && inplay.INPLAY_ODDS_MAX_AGE_MIN <= 60,
    'a live price window is minutes, not hours');
});

test('captureInplaySeries reads the SAME window the signal stages do', () => {
  // These two disagreed — the chart read 10 minutes and the signals beside it
  // read 24 hours. One constant now, and this is what keeps it one.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'captureInplaySeries.js'), 'utf8');
  assert.ok(/require\('\.\/lib\/inplay'\)/.test(src), 'must read the shared constant');
  assert.ok(!/process\.env\.INPLAY_ODDS_MAX_AGE_MIN\s*\|\|\s*'10'/.test(src),
    'must not re-declare its own copy of the window');
});

test('winProbStage actually PASSES the census — a dead out-parameter is the trap', () => {
  // Written after the secondary-market census shipped dead for a day: the
  // function took it, the tests covered it, and the call site went on passing
  // the old argument list, so it defaulted to null on every production run.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'computeInplayValues.js'), 'utf8');
  assert.ok(/winProbCandidates\(m,\s*baseByMatch\.get\(m\.id\),\s*\{\s*census\s*\}\)/.test(src),
    'winProbStage must hand winProbCandidates the census');
  assert.ok(/win-prob declined:/.test(src), 'and must print it');
});

test('the census counts the ceiling separately from the max-edge guard', () => {
  // They are different findings — one says the model is not calibrated at this
  // price, the other says it is not calibrated at all — and an empty board that
  // cannot tell them apart is one silence with two causes.
  const census = { overPriceCeiling: 0, belowEv: 0, aboveMaxEdge: 0 };
  winProbCandidates(liveH2h([2.60, 2.10, 5.00]), lam, { census });
  // home 2.60 is inside the price band and simply has no edge (-24.9%);
  // the draw fires; away 5.00 is declined on price and never reaches the edge.
  assert.strictEqual(census.overPriceCeiling, 1);
  assert.strictEqual(census.belowEv, 1);
  assert.strictEqual(census.aboveMaxEdge, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
