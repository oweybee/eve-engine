'use strict';

/**
 * engine.inplay.test.js — unit tests for the in-play pipeline's pure logic.
 * Run: node engine.inplay.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const inplay = require('./lib/inplay');
const { buildMessage, isInplay, chatIdForSignal } = require('./postToX');
const { extractLiveH2h } = require('./ingestLiveOdds');

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
  signal_category: 'Standard',
  match: { home_team: { name: 'A' }, away_team: { name: 'B' }, league: { name: 'L' } },
};
test('isInplay true for inplay phase', () => assert.ok(isInplay(inplaySignal)));
test('in-play message has live header + score', () => {
  const m = buildMessage(inplaySignal);
  assert.ok(m.includes('IN-PLAY VALUE'), 'header');
  assert.ok(m.includes('Live: 0-1 40\''), 'live score');
  assert.ok(m.includes('#InPlay'), 'hashtag');
});
test('prematch message unchanged (Kickoff line, value header)', () => {
  const m = buildMessage(prematchSignal);
  assert.ok(m.includes('VALUE SIGNAL'));
  assert.ok(m.includes('Kickoff:'));
  assert.ok(!m.includes('IN-PLAY'));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
