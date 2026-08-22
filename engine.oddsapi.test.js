/**
 * engine.oddsapi.test.js — The Odds API client helpers + credit guard.
 * Run: node engine.oddsapi.test.js
 */
'use strict';
const assert = require('assert');
const { quotaFromHeaders, requestCost, canSpend, mapSportKeys, parseEvent,
        sportKeysAreUnique } =
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

/**
 * THE REAL /v4/sports RESPONSE, 22 Aug 2026 — every soccer entry, verbatim.
 *
 * The fixture this replaced carried `group: 'England'`, `group: 'Germany'` and
 * so on. It was authored from the v4 docs by the same hand that wrote the
 * matchers those docs were guessed into, so the tests agreed with the code and
 * both were wrong: `group` is the literal string "Soccer" on all 67 entries,
 * every matcher failed, and the account spent 0 of 100,000 credits for as long
 * as the integration existed. A fixture built from a guess tests the guess.
 *
 * Captured by `scripts/oddsApiCatalogue.js` from a runner — the-odds-api.com is
 * egress-blocked from the development environment, which is why nobody had ever
 * seen this. Regenerate it the same way; do not hand-edit an entry.
 *
 * The near-misses are kept deliberately: soccer_brazil_serie_b beside Série A,
 * the Champions League _qualification and _women variants, soccer_germany_liga3
 * beside Bundesliga 2, and the Superettan beside the Allsvenskan. A fixture
 * holding only the rows we want to match cannot catch a greedy title fallback.
 */
const SPORTS = [
  { key: 'soccer_africa_cup_of_nations', group: 'Soccer', title: 'Africa Cup of Nations', description: 'Africa Cup of Nations' },
  { key: 'soccer_argentina_primera_division', group: 'Soccer', title: 'Primera División - Argentina', description: 'Argentine Primera División' },
  { key: 'soccer_australia_aleague', group: 'Soccer', title: 'A-League', description: 'Aussie Soccer' },
  { key: 'soccer_austria_bundesliga', group: 'Soccer', title: 'Austrian Football Bundesliga', description: 'Austrian Soccer' },
  { key: 'soccer_belgium_first_div', group: 'Soccer', title: 'Belgium First Div', description: 'Belgian First Division A' },
  { key: 'soccer_brazil_campeonato', group: 'Soccer', title: 'Brazil Série A', description: 'Brasileirão Série A' },
  { key: 'soccer_brazil_serie_b', group: 'Soccer', title: 'Brazil Série B', description: 'Campeonato Brasileiro Série B' },
  { key: 'soccer_chile_campeonato', group: 'Soccer', title: 'Primera División - Chile', description: 'Campeonato Chileno' },
  { key: 'soccer_china_superleague', group: 'Soccer', title: 'Super League - China', description: 'Chinese Soccer' },
  { key: 'soccer_concacaf_gold_cup', group: 'Soccer', title: 'CONCACAF Gold Cup', description: 'CONCACAF Gold Cup' },
  { key: 'soccer_concacaf_leagues_cup', group: 'Soccer', title: 'Leagues Cup', description: 'CONCACAF Leagues Cup' },
  { key: 'soccer_conmebol_copa_america', group: 'Soccer', title: 'Copa América', description: 'CONMEBOL Copa América' },
  { key: 'soccer_conmebol_copa_libertadores', group: 'Soccer', title: 'Copa Libertadores', description: 'CONMEBOL Copa Libertadores' },
  { key: 'soccer_conmebol_copa_sudamericana', group: 'Soccer', title: 'Copa Sudamericana', description: 'CONMEBOL Copa Sudamericana' },
  { key: 'soccer_denmark_superliga', group: 'Soccer', title: 'Denmark Superliga', description: 'Danish Soccer' },
  { key: 'soccer_efl_champ', group: 'Soccer', title: 'Championship', description: 'EFL Championship' },
  { key: 'soccer_england_efl_cup', group: 'Soccer', title: 'EFL Cup', description: 'League Cup' },
  { key: 'soccer_england_league1', group: 'Soccer', title: 'League 1', description: 'EFL League 1' },
  { key: 'soccer_england_league2', group: 'Soccer', title: 'League 2', description: 'EFL League 2' },
  { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: 'English Premier League' },
  { key: 'soccer_fa_cup', group: 'Soccer', title: 'FA Cup', description: 'Football Association Challenge Cup' },
  { key: 'soccer_fifa_club_world_cup', group: 'Soccer', title: 'FIFA Club World Cup', description: 'FIFA Club World Cup' },
  { key: 'soccer_fifa_world_cup', group: 'Soccer', title: 'FIFA World Cup', description: 'FIFA World Cup 2026' },
  { key: 'soccer_fifa_world_cup_qualifiers_europe', group: 'Soccer', title: 'FIFA World Cup Qualifiers - Europe', description: 'FIFA World Cup Qualifiers - UEFA' },
  { key: 'soccer_fifa_world_cup_qualifiers_south_america', group: 'Soccer', title: 'FIFA World Cup Qualifiers - South America', description: 'FIFA World Cup Qualifiers - CONMEBOL' },
  { key: 'soccer_fifa_world_cup_winner', group: 'Soccer', title: 'FIFA World Cup Winner', description: 'FIFA World Cup Winner 2030' },
  { key: 'soccer_fifa_world_cup_womens', group: 'Soccer', title: 'FIFA Women\'s World Cup', description: 'FIFA Women\'s World Cup' },
  { key: 'soccer_finland_veikkausliiga', group: 'Soccer', title: 'Veikkausliiga - Finland', description: 'Finnish  Soccer' },
  { key: 'soccer_france_coupe_de_france', group: 'Soccer', title: 'Coupe de France', description: 'French Soccer' },
  { key: 'soccer_france_ligue_one', group: 'Soccer', title: 'Ligue 1 - France', description: 'French Soccer' },
  { key: 'soccer_france_ligue_two', group: 'Soccer', title: 'Ligue 2 - France', description: 'French Soccer' },
  { key: 'soccer_germany_bundesliga', group: 'Soccer', title: 'Bundesliga - Germany', description: 'German Soccer' },
  { key: 'soccer_germany_bundesliga2', group: 'Soccer', title: 'Bundesliga 2 - Germany', description: 'German Soccer' },
  { key: 'soccer_germany_bundesliga_women', group: 'Soccer', title: 'Frauen-Bundesliga', description: 'German Soccer' },
  { key: 'soccer_germany_dfb_pokal', group: 'Soccer', title: 'DFB-Pokal', description: 'German Soccer' },
  { key: 'soccer_germany_liga3', group: 'Soccer', title: '3. Liga - Germany', description: 'German Soccer' },
  { key: 'soccer_greece_super_league', group: 'Soccer', title: 'Super League - Greece', description: 'Greek Soccer' },
  { key: 'soccer_italy_coppa_italia', group: 'Soccer', title: 'Coppa Italia', description: 'Italian Soccer' },
  { key: 'soccer_italy_serie_a', group: 'Soccer', title: 'Serie A - Italy', description: 'Italian Soccer' },
  { key: 'soccer_italy_serie_b', group: 'Soccer', title: 'Serie B - Italy', description: 'Italian Soccer' },
  { key: 'soccer_japan_j_league', group: 'Soccer', title: 'J League', description: 'Japan Soccer League' },
  { key: 'soccer_korea_kleague1', group: 'Soccer', title: 'K League 1', description: 'Korean Soccer' },
  { key: 'soccer_league_of_ireland', group: 'Soccer', title: 'League of Ireland', description: 'Airtricity League Premier Division' },
  { key: 'soccer_mexico_ligamx', group: 'Soccer', title: 'Liga MX', description: 'Mexican Soccer' },
  { key: 'soccer_netherlands_eredivisie', group: 'Soccer', title: 'Dutch Eredivisie', description: 'Dutch Soccer' },
  { key: 'soccer_norway_eliteserien', group: 'Soccer', title: 'Eliteserien - Norway', description: 'Norwegian Soccer' },
  { key: 'soccer_poland_ekstraklasa', group: 'Soccer', title: 'Ekstraklasa - Poland', description: 'Polish Soccer' },
  { key: 'soccer_portugal_primeira_liga', group: 'Soccer', title: 'Primeira Liga - Portugal', description: 'Portugese Soccer' },
  { key: 'soccer_russia_premier_league', group: 'Soccer', title: 'Premier League - Russia', description: 'Russian Soccer' },
  { key: 'soccer_saudi_arabia_pro_league', group: 'Soccer', title: 'Saudi Pro League', description: 'Saudi Soccer' },
  { key: 'soccer_spain_copa_del_rey', group: 'Soccer', title: 'Copa del Rey', description: 'Spanish Soccer' },
  { key: 'soccer_spain_la_liga', group: 'Soccer', title: 'La Liga - Spain', description: 'Spanish Soccer' },
  { key: 'soccer_spain_segunda_division', group: 'Soccer', title: 'La Liga 2 - Spain', description: 'Spanish Soccer' },
  { key: 'soccer_spl', group: 'Soccer', title: 'Premiership - Scotland', description: 'Scottish Premiership' },
  { key: 'soccer_sweden_allsvenskan', group: 'Soccer', title: 'Allsvenskan - Sweden', description: 'Swedish Soccer' },
  { key: 'soccer_sweden_superettan', group: 'Soccer', title: 'Superettan - Sweden', description: 'Swedish Soccer' },
  { key: 'soccer_switzerland_superleague', group: 'Soccer', title: 'Swiss Superleague', description: 'Swiss Soccer' },
  { key: 'soccer_turkey_super_league', group: 'Soccer', title: 'Turkey Super League', description: 'Turkish Soccer' },
  { key: 'soccer_uefa_champs_league', group: 'Soccer', title: 'UEFA Champions League', description: 'European Champions League' },
  { key: 'soccer_uefa_champs_league_qualification', group: 'Soccer', title: 'UEFA Champions League Qualification', description: 'European Champions League Qualification' },
  { key: 'soccer_uefa_champs_league_women', group: 'Soccer', title: 'UEFA Champions League Women', description: 'European Champions League Women' },
  { key: 'soccer_uefa_euro_qualification', group: 'Soccer', title: 'UEFA Euro Qualification', description: 'European Championship Qualification' },
  { key: 'soccer_uefa_europa_conference_league', group: 'Soccer', title: 'UEFA Europa Conference League', description: 'UEFA Europa Conference League' },
  { key: 'soccer_uefa_europa_league', group: 'Soccer', title: 'UEFA Europa League', description: 'European Europa League' },
  { key: 'soccer_uefa_european_championship', group: 'Soccer', title: 'UEFA Euro', description: 'UEFA European Championship' },
  { key: 'soccer_uefa_nations_league', group: 'Soccer', title: 'UEFA Nations League', description: 'UEFA Nations League' },
  { key: 'soccer_usa_mls', group: 'Soccer', title: 'MLS', description: 'Major League Soccer' },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA', description: 'US Basketball' },
];

test('every tracked league resolves to its real sport key', () => {
  const { map, unmatched, unavailable, renamed, collisions } = mapSportKeys(SPORTS);

  // The English pyramid, which is where a shifted table does its damage:
  // e1 is the CHAMPIONSHIP, not League One. A table that reads the digit
  // instead of the code polls the Championship twice and League Two never.
  assert.strictEqual(map.epl, 'soccer_epl');
  assert.strictEqual(map.e1, 'soccer_efl_champ');
  assert.strictEqual(map.e2, 'soccer_england_league1');
  assert.strictEqual(map.e3, 'soccer_england_league2');
  assert.strictEqual(map.eng_league_cup, 'soccer_england_efl_cup');

  assert.strictEqual(map.sc0, 'soccer_spl');
  assert.strictEqual(map.laliga, 'soccer_spain_la_liga');
  assert.strictEqual(map.sp2, 'soccer_spain_segunda_division');
  assert.strictEqual(map.bundesliga, 'soccer_germany_bundesliga');
  assert.strictEqual(map.d2, 'soccer_germany_bundesliga2');
  assert.strictEqual(map.seriea, 'soccer_italy_serie_a');
  assert.strictEqual(map.i2, 'soccer_italy_serie_b');
  assert.strictEqual(map.ligue1, 'soccer_france_ligue_one');
  assert.strictEqual(map.f2, 'soccer_france_ligue_two');
  assert.strictEqual(map.n1, 'soccer_netherlands_eredivisie');
  assert.strictEqual(map.p1, 'soccer_portugal_primeira_liga');
  assert.strictEqual(map.t1, 'soccer_turkey_super_league');
  assert.strictEqual(map.g1, 'soccer_greece_super_league');
  assert.strictEqual(map.b1, 'soccer_belgium_first_div');
  assert.strictEqual(map.brazil_seriea, 'soccer_brazil_campeonato');
  assert.strictEqual(map.argentina_ligaprofesional, 'soccer_argentina_primera_division');
  assert.strictEqual(map.japan_j1league, 'soccer_japan_j_league');
  assert.strictEqual(map.ireland_premierdivision, 'soccer_league_of_ireland');
  assert.strictEqual(map.russia_premierleague, 'soccer_russia_premier_league');
  assert.strictEqual(map.ucl, 'soccer_uefa_champs_league');
  assert.strictEqual(map.uecl, 'soccer_uefa_europa_conference_league');

  // 36 of 38. THE OTHER TWO ARE NOT A BUG HERE: the catalogue carries no
  // England National League and no Romanian division, so `ec` and
  // romania_superliga are `unavailable` — a fact about the feed. The test
  // asserts the COUNT so a future catalogue that adds one is noticed.
  assert.strictEqual(Object.keys(map).length, 36, 'expected 36 of 38 to resolve');
  assert.deepStrictEqual(unavailable.sort(), ['ec', 'romania_superliga']);
  assert.deepStrictEqual(unmatched, [], 'nothing we expect a key for may be missing');
  assert.deepStrictEqual(renamed, [], 'no rename against the captured catalogue');
  assert.deepStrictEqual(collisions, [], 'two leagues must never share a sport key');
});

test('the dictionary itself has no two leagues claiming one key', () => {
  assert.deepStrictEqual(sportKeysAreUnique(), []);
});

test('no non-soccer key can enter the map', () => {
  const { map } = mapSportKeys(SPORTS);
  for (const v of Object.values(map)) {
    assert.ok(String(v).startsWith('soccer'), `non-soccer key mapped: ${v}`);
  }
});

test('the near-misses in the catalogue are not swallowed', () => {
  const { map } = mapSportKeys(SPORTS);
  const taken = new Set(Object.values(map));
  // Each of these sits one greedy regex away from a league we DO want.
  for (const trap of ['soccer_brazil_serie_b', 'soccer_germany_liga3',
                      'soccer_sweden_superettan', 'soccer_uefa_champs_league_women',
                      'soccer_uefa_champs_league_qualification',
                      'soccer_uefa_europa_league', 'soccer_fa_cup']) {
    assert.ok(!taken.has(trap), `${trap} was claimed by a tracked league`);
  }
});

test('the title fallback fires on a renamed key, and refuses an ambiguous one', () => {
  // Rename EPL's key; the title still says "EPL", so it resolves and REPORTS.
  const renamedCat = SPORTS.map(s =>
    s.key === 'soccer_epl' ? { ...s, key: 'soccer_epl_v2' } : s);
  const r = mapSportKeys(renamedCat);
  assert.strictEqual(r.map.epl, 'soccer_epl_v2');
  assert.ok(r.renamed.some(m => m.includes('epl')), 'a rename must be reported');

  // Two entries answering one title is refused rather than resolved to
  // whichever came first — a wrong league is worse than a missing one.
  const ambiguous = SPORTS
    .filter(s => s.key !== 'soccer_epl')
    .concat([{ key: 'soccer_epl_a', group: 'Soccer', title: 'EPL', description: 'x' },
             { key: 'soccer_epl_b', group: 'Soccer', title: 'EPL', description: 'y' }]);
  const amb = mapSportKeys(ambiguous);
  assert.strictEqual(amb.map.epl, undefined, 'ambiguity must not resolve');
  assert.ok(amb.unmatched.includes('epl'), 'and must be reported');
});

test('an empty catalogue resolves nothing and says so — it does not throw', () => {
  const empty = mapSportKeys([]);
  assert.deepStrictEqual(empty.map, {});
  assert.ok(empty.unmatched.length + empty.unavailable.length === 38);
  assert.deepStrictEqual(mapSportKeys(null).map, {});
});

test('mapSportKeys honours includeCups=false', () => {
  const { map } = mapSportKeys(SPORTS, { includeCups: false });
  assert.strictEqual(map.epl, 'soccer_epl');
  assert.strictEqual(map.ucl, undefined, 'cups excluded');
  assert.strictEqual(map.eng_league_cup, undefined, 'cups excluded');
});

test('targetLeagues narrows the set, as an array or an option', () => {
  const asArray = mapSportKeys(SPORTS, ['epl', 'laliga']);
  assert.deepStrictEqual(Object.keys(asArray.map).sort(), ['epl', 'laliga']);
  const asOpt = mapSportKeys(SPORTS, { targetLeagues: ['epl'] });
  assert.deepStrictEqual(Object.keys(asOpt.map), ['epl']);
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
