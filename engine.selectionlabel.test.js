'use strict';
/**
 * engine.selectionlabel.test.js — lib/selectionLabel, the one formatter that
 * turns (market, outcome, line) into words. Every expected string below is
 * what public.selection_label() in the database returns for the same inputs
 * (read 16 Oct 2026 with pg_get_functiondef), so the engine's posts and the
 * site cannot name one bet two ways. Run: node engine.selectionlabel.test.js
 */

const assert = require('assert');
const {
  selectionLabel, selectionLabelForSignal, marketName, normaliseMarket,
} = require('./lib/selectionLabel');
const { selectionText } = require('./lib/discordCompose');
const { buildMessage } = require('./postToX');
const { bodyFor } = require('./postToXChannel');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`); }
}

const H = 'Arsenal';
const A = 'Chelsea';
const L = (market, outcome, line = null) => selectionLabel({ market, outcome, line, home: H, away: A });

console.log('existing markets, unchanged');
test('h2h', () => {
  assert.strictEqual(L('h2h', 'home'), 'Arsenal to win');
  assert.strictEqual(L('h2h', 'away'), 'Chelsea to win');
  assert.strictEqual(L('h2h', 'draw'), 'Draw');
});
test('totals carries the line and the noun', () => {
  assert.strictEqual(L('totals', 'over', 2.5), 'Over 2.5 goals');
  assert.strictEqual(L('totals', 'under', '3.50'), 'Under 3.5 goals', 'trim_scale drops trailing zeros');
  assert.strictEqual(L('totals', 'over', 3), 'Over 3 goals');
});
test('btts', () => {
  assert.strictEqual(L('btts', 'btts_yes'), 'Both teams to score: Yes');
  assert.strictEqual(L('btts', 'btts_no'), 'Both teams to score: No');
});

console.log('double chance and draw no bet');
test('dc names both sides of the cover', () => {
  assert.strictEqual(L('dc', 'dc_1x'), 'Arsenal or draw');
  assert.strictEqual(L('dc', 'dc_x2'), 'Chelsea or draw');
  assert.strictEqual(L('dc', 'dc_12'), 'Arsenal or Chelsea');
});
test('dnb', () => {
  assert.strictEqual(L('dnb', 'dnb_home'), 'Arsenal (draw no bet)');
  assert.strictEqual(L('dnb', 'dnb_away'), 'Chelsea (draw no bet)');
});

console.log('Asian handicap: market_line is the HOME handicap');
test('line 0 reads 0 on both sides, never +0 or -0', () => {
  assert.strictEqual(L('ah', 'ah_home', 0), 'Arsenal 0 (Asian handicap)');
  assert.strictEqual(L('ah', 'ah_away', 0), 'Chelsea 0 (Asian handicap)');
  assert.strictEqual(L('ah', 'ah_away', '0.00'), 'Chelsea 0 (Asian handicap)');
});
test('line -0.5', () => {
  assert.strictEqual(L('ah', 'ah_home', -0.5), 'Arsenal -0.5 (Asian handicap)');
  assert.strictEqual(L('ah', 'ah_away', -0.5), 'Chelsea +0.5 (Asian handicap)');
});
test('line +1', () => {
  assert.strictEqual(L('ah', 'ah_home', 1), 'Arsenal +1 (Asian handicap)');
  assert.strictEqual(L('ah', 'ah_away', 1), 'Chelsea -1 (Asian handicap)');
});
test('line -1.5', () => {
  assert.strictEqual(L('ah', 'ah_home', -1.5), 'Arsenal -1.5 (Asian handicap)');
  assert.strictEqual(L('ah', 'ah_away', '-1.50'), 'Chelsea +1.5 (Asian handicap)');
});

console.log('corners and cards');
test('corners', () => {
  assert.strictEqual(L('corners', 'over', 9.5), 'Over 9.5 corners');
  assert.strictEqual(L('corners', 'under', 10.5), 'Under 10.5 corners');
});
test('bookings reads as cards, and the older key cards is identical', () => {
  assert.strictEqual(L('bookings', 'under', 4.5), 'Under 4.5 cards');
  assert.strictEqual(L('cards', 'under', 4.5), L('bookings', 'under', 4.5));
  assert.strictEqual(L('cards', 'over', 3.5), 'Over 3.5 cards');
  assert.strictEqual(L('CARDS', 'over', 3.5), 'Over 3.5 cards', 'case-insensitive');
  assert.strictEqual(normaliseMarket('cards'), 'bookings');
});

console.log('failing open');
test('an unknown market returns the outcome, not a throw and not "Draw"', () => {
  assert.strictEqual(L('shots', 'over_shots'), 'over shots', 'no underscore reaches Telegram');
  assert.strictEqual(L('mystery', 'x'), 'x');
  assert.strictEqual(selectionLabel({}), '');
});
test('an unknown outcome inside a known market falls back to the outcome', () => {
  assert.strictEqual(L('dc', 'dc_99'), 'dc 99');
  assert.strictEqual(L('ah', 'ah_middle', 1), 'ah middle');
  assert.strictEqual(L('totals', 'exactly', 2), 'exactly');
});
test('a missing line is dropped rather than printed as null or NaN', () => {
  assert.strictEqual(L('corners', 'over', null), 'Over corners');
  assert.strictEqual(L('ah', 'ah_home', null), 'Arsenal (Asian handicap)');
  assert.strictEqual(L('totals', 'over', 'abc'), 'Over goals');
});
test('a missing market, or an h2h row with a non-1X2 outcome, is read off the outcome', () => {
  assert.strictEqual(L(null, 'over', 2.5), 'Over 2.5 goals');
  assert.strictEqual(L(null, 'btts_no'), 'Both teams to score: No');
  assert.strictEqual(L(null, 'dc_1x'), 'Arsenal or draw');
  assert.strictEqual(L(null, 'home'), 'Arsenal to win');
  assert.strictEqual(L('h2h', 'btts_yes'), 'Both teams to score: Yes', 'not "Draw"');
});
test('missing team names degrade to Home / Away', () => {
  assert.strictEqual(selectionLabel({ market: 'dc', outcome: 'dc_12' }), 'Home or Away');
});

console.log('market display names');
test('every market has a reader-facing name', () => {
  assert.strictEqual(marketName('h2h'), 'Match result');
  assert.strictEqual(marketName('totals'), 'Goals');
  assert.strictEqual(marketName('btts'), 'Both teams to score');
  assert.strictEqual(marketName('dc'), 'Double chance');
  assert.strictEqual(marketName('dnb'), 'Draw no bet');
  assert.strictEqual(marketName('ah'), 'Asian handicap');
  assert.strictEqual(marketName('corners'), 'Corners');
  assert.strictEqual(marketName('bookings'), 'Cards');
  assert.strictEqual(marketName('cards'), 'Cards');
  assert.strictEqual(marketName('shots'), 'shots', 'unknown fails open to the key');
});

console.log('every poster reads the one helper');
const sig = over => ({
  id: 's', market: 'ah', market_line: -0.5, outcome: 'ah_away',
  detected_odds: 1.95, detected_edge: 0.055, detected_mes: null, bookmaker: 'bet365',
  phase: 'prematch', is_mover: false, model_architecture: 'MARKET_ANCHORED',
  mxs: 70, mxs_band: 'PRIME', kickoff_at: '2026-10-18T14:00:00Z',
  match: { home_team: { name: H }, away_team: { name: A }, league: { name: 'Premier League' } },
  ...over,
});
test('the row helper reads market, outcome, market_line and both teams', () => {
  assert.strictEqual(selectionLabelForSignal(sig()), 'Chelsea +0.5 (Asian handicap)');
});
test('Discord #signals', () => {
  assert.strictEqual(selectionText(sig()), 'Chelsea +0.5 (Asian handicap)');
  assert.strictEqual(selectionText(sig({ market: 'cards', outcome: 'under', market_line: 4.5 })), 'Under 4.5 cards');
});
test('Telegram (postToX.buildMessage), pre-match and in-play', () => {
  assert.ok(buildMessage(sig()).includes('Chelsea +0.5 (Asian handicap) @ 1.95'));
  const live = buildMessage(sig({ phase: 'inplay', market: 'corners', outcome: 'over', market_line: 9.5,
    model_architecture: 'INPLAY_DIXON_COLES', match: { ...sig().match, goals_home: 0, goals_away: 0, minute: 30 } }));
  assert.ok(live.includes('*Over 9.5 corners* @ *1.95*'), live);
});
test('the X channel (postToXChannel.bodyFor)', () => {
  const body = [0, 1, 2, 3, 4, 5].map(v => { try { return bodyFor(sig({ market: 'dc', outcome: 'dc_1x', market_line: null }), v); } catch { return ''; } }).join('\n');
  assert.ok(/Arsenal or draw/i.test(body), body);
  assert.ok(!/dc_1x/.test(body), 'the raw key must not reach a reader');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
