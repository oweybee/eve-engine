/**
 * engine.oddsapi.test.js — The Odds API client helpers + credit guard.
 * Run: node engine.oddsapi.test.js
 */
'use strict';
const assert = require('assert');
const { quotaFromHeaders, requestCost, canSpend, mapSportKeys, parseEvent } =
  require('./lib/oddsApi');
const { resolveMatch } = require('./ingestOddsApi');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

test('requestCost = regions x markets', () => {
  assert.strictEqual(requestCost('uk', 'h2h'), 1);
  assert.strictEqual(requestCost('uk', 'h2h,totals'), 2);
  assert.strictEqual(requestCost('uk,eu', 'h2h,totals'), 4);
  assert.strictEqual(requestCost('', ''), 1);          // never zero
});

test('quotaFromHeaders reads the authoritative counters', () => {
  const q = quotaFromHeaders({ 'x-requests-used': '812', 'x-requests-remaining': '99188',
                               'x-requests-last': '2' });
  assert.strictEqual(q.used, 812);
  assert.strictEqual(q.remaining, 99188);
  assert.strictEqual(q.lastCost, 2);
  const none = quotaFromHeaders({});
  assert.strictEqual(none.remaining, null);
});

test('credit guard: stops at the reserve, allows above it', () => {
  assert.strictEqual(canSpend({ remaining: 5000, cost: 2, reserve: 2000 }), true);
  assert.strictEqual(canSpend({ remaining: 2002, cost: 2, reserve: 2000 }), true);
  assert.strictEqual(canSpend({ remaining: 2001, cost: 2, reserve: 2000 }), false);
  assert.strictEqual(canSpend({ remaining: 0, cost: 1, reserve: 0 }), false);
  // unknown quota (before the first call) must not block the run
  assert.strictEqual(canSpend({ remaining: null, cost: 2, reserve: 2000 }), true);
});

const SPORTS = [
  { key: 'soccer_epl', group: 'England', title: 'Premier League' },
  { key: 'soccer_efl_champ', group: 'England', title: 'Championship' },
  { key: 'soccer_england_league1', group: 'England', title: 'League 1' },
  { key: 'soccer_spl', group: 'Scotland', title: 'Premiership' },
  { key: 'soccer_germany_bundesliga', group: 'Germany', title: 'Bundesliga' },
  { key: 'soccer_uefa_champs_league', group: 'World', title: 'UEFA Champions League' },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA' },
];

test('mapSportKeys resolves from the FREE catalogue, reports gaps', () => {
  const { map, unmatched } = mapSportKeys(SPORTS);
  assert.strictEqual(map.epl, 'soccer_epl');
  assert.strictEqual(map.e1, 'soccer_efl_champ');
  assert.strictEqual(map.e2, 'soccer_england_league1');
  assert.strictEqual(map.sc0, 'soccer_spl');
  assert.strictEqual(map.bundesliga, 'soccer_germany_bundesliga');
  assert.strictEqual(map.ucl, 'soccer_uefa_champs_league');
  assert.ok(!Object.values(map).includes('basketball_nba'), 'must not map non-soccer');
  assert.ok(unmatched.includes('laliga'), 'absent leagues are reported, not silent');
});

test('mapSportKeys honours includeCups=false', () => {
  const { map } = mapSportKeys(SPORTS, { includeCups: false });
  assert.strictEqual(map.ucl, undefined);
  assert.strictEqual(map.epl, 'soccer_epl');
});

const EVENT = {
  home_team: 'Arsenal', away_team: 'Chelsea', commence_time: '2026-08-15T14:00:00Z',
  bookmakers: [
    { key: 'skybet', markets: [
      { key: 'h2h', outcomes: [
        { name: 'Arsenal', price: 2.10 }, { name: 'Chelsea', price: 3.60 },
        { name: 'Draw', price: 3.50 }] },
      { key: 'totals', outcomes: [
        { name: 'Over', point: 2.5, price: 1.95 }, { name: 'Under', point: 2.5, price: 1.90 },
        { name: 'Over', point: 3.5, price: 3.20 }] },
    ] },
    { key: 'paddypower', markets: [
      { key: 'h2h', outcomes: [
        { name: 'Arsenal', price: 2.05 }, { name: 'Chelsea', price: 3.75 },
        { name: 'Draw', price: 3.40 }] }] },
    { key: 'brokenbook', markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2.0 }] }] },
  ],
};

test('parseEvent → engine odds rows, correct totals convention', () => {
  const rows = parseEvent(EVENT);
  const h2h = rows.filter(r => r.market === 'h2h');
  assert.strictEqual(h2h.length, 2, 'incomplete bookmaker dropped');
  const sky = h2h.find(r => r.bookmaker === 'skybet');
  assert.strictEqual(sky.home_odds, 2.10);
  assert.strictEqual(sky.away_odds, 3.60);
  assert.strictEqual(sky.draw_odds, 3.50);
  const tot = rows.find(r => r.market === 'totals');
  assert.strictEqual(tot.market_line, 2.5);
  assert.strictEqual(tot.home_odds, 1.95, 'home_odds = OVER (engine convention)');
  assert.strictEqual(tot.away_odds, 1.90, 'away_odds = UNDER');
  assert.ok(rows.every(r => r.market_line === null || r.market_line === 2.5),
    'only the target totals line');
});

test('resolveMatch: name normalisation + kickoff proximity', () => {
  const { clubKey } = require('./lib/lambdaBoard');
  const ko = new Date('2026-08-15T14:00:00Z').getTime();
  const idx = new Map([[`${clubKey('Arsenal')}|${clubKey('Chelsea')}`,
                        [{ id: 'match-1', ko }]]]);
  assert.strictEqual(resolveMatch(idx, EVENT), 'match-1');
  // >90min away → no match
  assert.strictEqual(resolveMatch(idx,
    { ...EVENT, commence_time: '2026-08-15T18:00:00Z' }), null);
  // unknown teams → no match, never a wrong join
  assert.strictEqual(resolveMatch(idx,
    { ...EVENT, home_team: 'Unknown FC' }), null);
});

test('short-name variants still resolve (Man City / Manchester City)', () => {
  const { clubKey } = require('./lib/lambdaBoard');
  const ko = new Date('2026-08-15T14:00:00Z').getTime();
  const idx = new Map([[`${clubKey('Man City')}|${clubKey('Arsenal')}`,
                        [{ id: 'm2', ko }]]]);
  assert.strictEqual(resolveMatch(idx, { home_team: 'Manchester City', away_team: 'Arsenal',
    commence_time: '2026-08-15T14:00:00Z' }), 'm2');
});

console.log(`\nodds api tests: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
