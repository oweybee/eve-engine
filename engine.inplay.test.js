'use strict';

/**
 * engine.inplay.test.js — unit tests for the in-play pipeline's pure logic.
 * Run: node engine.inplay.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const inplay = require('./lib/inplay');
const { buildMessage, isInplay, isSuggested, isBroadcastable, bandOf, chatIdForSignal } = require('./postToX');
const { classifyTier, dedupeConflicts } = require('./lib/signalTier');
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
const prematchSignal = {
  phase: 'prematch', outcome: 'away', detected_odds: 2.5, detected_edge: 0.03,
  detected_mes: 60, bookmaker: 'Bet365', kickoff_at: new Date(KO).toISOString(),
  signal_category: 'Value',
  match: { home_team: { name: 'A' }, away_team: { name: 'B' }, league: { name: 'L' } },
};
test('isInplay true for inplay phase', () => assert.ok(isInplay(inplaySignal)));
test('in-play message has live header + score', () => {
  const m = buildMessage(inplaySignal);
  assert.ok(m.includes('IN-PLAY VALUE'), 'header');
  assert.ok(m.includes('Live: 0-1 40\''), 'live score');
  assert.ok(m.includes('#InPlay'), 'hashtag');
});
test('prematch unbacked edge (odds 2.5 / edge 3%) → info-only header, not suggested', () => {
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

// Tier classifier + PRIME broadcast policy -----------------------------------
//
// SINCE 6 Aug 2026 A BROADCAST NEEDS BOTH LADDERS. `PRIME SIGNAL` means what a
// ◆ PRIME badge on the site means — the eligibility ladder suggests it AND the
// conviction ladder scores it 65+ — so the word cannot say one thing in the
// channel and another on a row. A suggested selection we could not score is
// not broadcast at all.
const primeSignal = {
  ...prematchSignal, detected_odds: 2.2, detected_edge: 0.09,
  model_architecture: 'DIXON_COLES', mxs: 76, mxs_band: 'PRIME',
};
const longshotSignal = { ...prematchSignal, detected_odds: 5.0, detected_edge: 0.07 };

test('prime box + PRIME score → PRIME header, broadcastable', () => {
  assert.strictEqual(classifyTier(primeSignal).tier, 'prime');
  assert.strictEqual(isSuggested(primeSignal), true);
  assert.strictEqual(isBroadcastable(primeSignal), true);
  const m = buildMessage(primeSignal);
  assert.ok(m.includes('PRIME SIGNAL'), 'header');
  assert.ok(m.includes('backed'), 'backed note');
  assert.ok(m.includes('76/100'), 'states the score it is claiming');
});

test('the rung is read from the row, and recomputed when it is absent', () => {
  // A backfilled or legacy row carries no mxs_band; the same formula fills it
  // in rather than silently making the signal unbroadcastable.
  const { mxs, mxs_band, ...unstored } = primeSignal;
  assert.strictEqual(bandOf(unstored), 'PRIME');
  assert.strictEqual(isBroadcastable(unstored), true);
});

test('THE BOX AND THE RUNG DO NOT COINCIDE, and that is the point', () => {
  // odds 2.2 at a 6% edge is well inside the eligibility ladder's profitable
  // box, and it scores 62 — WATCH. Measured against production on 6 Aug 2026,
  // 4 of the 10 published prematch signals in the box clear MXS 65; the other
  // 6 do not. Under the old policy all 10 were broadcast as "PRIME SIGNAL"
  // while the site badged six of them WATCH. Requiring both is what stops the
  // word meaning two things, and a quieter channel is the cost of that.
  const inBox = { ...primeSignal, detected_edge: 0.06 };
  delete inBox.mxs; delete inBox.mxs_band;
  assert.strictEqual(classifyTier(inBox).suggested, true, 'the box suggests it');
  assert.strictEqual(bandOf(inBox), 'WATCH', 'the score does not back it');
  assert.strictEqual(isBroadcastable(inBox), false);
});

test('suggested but scored below PRIME is NOT broadcast', () => {
  // This is the case the old policy got wrong: the ladder suggests it, so the
  // channel would have opened with "PRIME SIGNAL" while the site badged WATCH.
  const watch = { ...primeSignal, mxs: 52, mxs_band: 'WATCH' };
  assert.strictEqual(isSuggested(watch), true);
  assert.strictEqual(isBroadcastable(watch), false);
});

test('suggested but UNSCORABLE is not broadcast either', () => {
  // An architecture with no row in model_calibration scores null, and null is
  // not PRIME. Silence is the right output for "we could not measure this".
  const unscored = { ...primeSignal, model_architecture: 'SUPERMODEL_HALFTIME' };
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
