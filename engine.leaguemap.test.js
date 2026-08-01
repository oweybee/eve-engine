/**
 * engine.leaguemap.test.js — production league (name, country) → corpus slug.
 * Run: node engine.leaguemap.test.js
 *
 * This mapping is the gate on the whole λ board: a fixture whose league doesn't
 * resolve is never priced, and one that resolves to the WRONG slug is priced
 * with another country's league stats. Both failures are silent, so they get
 * pinned here.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mapLeague } = require('./computeModelBoard');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

// ── the exact-name clashes that were mis-pricing fixtures ───────────────────
// API-Football gives England and Russia the same league NAME, and England and
// Scotland the same name for their second tier. Matching on name alone sent
// Russian and Scottish fixtures through English league stats.

test('"Premier League" splits England from Russia', () => {
  assert.strictEqual(mapLeague('Premier League', 'England'), 'epl');
  assert.strictEqual(mapLeague('Premier League', 'Russia'), 'russia_premierleague');
});

test('"Championship" splits England from Scotland', () => {
  assert.strictEqual(mapLeague('Championship', 'England'), 'e1');
  assert.strictEqual(mapLeague('Championship', 'Scotland'), 'sc1');
});

test('"League One"/"League Two" split England from Scotland', () => {
  assert.strictEqual(mapLeague('League One', 'England'), 'e2');
  assert.strictEqual(mapLeague('League One', 'Scotland'), 'sc2');
  assert.strictEqual(mapLeague('League Two', 'England'), 'e3');
  assert.strictEqual(mapLeague('League Two', 'Scotland'), 'sc3');
});

// ── the leagues that resolved to null because country was never in the name ──

test('Scottish Premiership resolves (was dropped: /scot/i vs "Premiership")', () => {
  assert.strictEqual(mapLeague('Premiership', 'Scotland'), 'sc0');
});

test('Swiss Super League resolves, and Challenge League is distinct', () => {
  assert.strictEqual(mapLeague('Super League', 'Switzerland'), 'switzerland_superleague');
  assert.strictEqual(mapLeague('Challenge League', 'Switzerland'), 'switzerland_challengeleague');
});

test('"Super League" still splits Greece and China', () => {
  assert.strictEqual(mapLeague('Super League', 'Greece'), 'g1');
  assert.strictEqual(mapLeague('Super League', 'China'), 'china_superleague');
});

// ── the leagues that had no pattern at all ──────────────────────────────────

test('previously unmapped leagues now resolve', () => {
  assert.strictEqual(mapLeague('Superliga', 'Denmark'), 'denmark_superliga');
  assert.strictEqual(mapLeague('Veikkausliiga', 'Finland'), 'finland_veikkausliiga');
  assert.strictEqual(mapLeague('Premier Division', 'Ireland'), 'ireland_premierdivision');
  assert.strictEqual(mapLeague('Liga I', 'Romania'), 'romania_superliga');
  assert.strictEqual(mapLeague('Liga Profesional Argentina', 'Argentina'),
                     'argentina_ligaprofesional');
  assert.strictEqual(mapLeague('Copa de la Liga Profesional', 'Argentina'),
                     'argentina_copadelaligaprofesional');
});

test('Argentina: Copa de la Liga wins over the plain league', () => {
  // Both contain "Liga Profesional"; the cup must not be priced as the league.
  assert.notStrictEqual(mapLeague('Copa de la Liga Profesional', 'Argentina'),
                        'argentina_ligaprofesional');
});

// ── the previously-working set must not regress ─────────────────────────────

test('established mappings still hold', () => {
  const cases = [
    ['Bundesliga', 'Germany', 'bundesliga'],
    ['2. Bundesliga', 'Germany', 'd2'],
    ['Bundesliga', 'Austria', 'austria_bundesliga'],
    ['La Liga', 'Spain', 'laliga'],
    ['Segunda División', 'Spain', 'sp2'],
    ['Serie A', 'Italy', 'seriea'],
    ['Serie A', 'Brazil', 'brazil_seriea'],
    ['Serie B', 'Italy', 'i2'],
    ['Ligue 1', 'France', 'ligue1'],
    ['Ligue 2', 'France', 'f2'],
    ['Eredivisie', 'Netherlands', 'n1'],
    ['Primeira Liga', 'Portugal', 'p1'],
    ['Süper Lig', 'Turkey', 't1'],
    ['Jupiler Pro League', 'Belgium', 'b1'],
    ['Allsvenskan', 'Sweden', 'allsvenskan'],
    ['Eliteserien', 'Norway', 'norway_eliteserien'],
    ['Ekstraklasa', 'Poland', 'poland_ekstraklasa'],
    ['National League', 'England', 'ec'],
    ['Major League Soccer', 'USA', 'mls'],
    ['Liga MX', 'Mexico', 'mexico_ligamx'],
    ['J1 League', 'Japan', 'japan_j1league'],
  ];
  for (const [name, country, want] of cases) {
    assert.strictEqual(mapLeague(name, country), want, `${name} / ${country}`);
  }
});

test('diacritics are folded — "Süper Lig" is the real production name', () => {
  // /super lig/i does not match "Süper Lig"; Turkey was silently dropped for as
  // long as this mapping has existed. Country is folded too, for "Türkiye".
  assert.strictEqual(mapLeague('Süper Lig', 'Turkey'), 't1');
  assert.strictEqual(mapLeague('Süper Lig', 'Türkiye'), 't1');
  assert.strictEqual(mapLeague('Segunda División', 'Spain'), 'sp2');
});

test('German tier names do not collide', () => {
  assert.strictEqual(mapLeague('1. Bundesliga', 'Germany'), 'bundesliga');
  assert.strictEqual(mapLeague('2. Bundesliga', 'Germany'), 'd2');
});

test('an UNLISTED country never borrows another country model', () => {
  // The whole point: a country we don't model must resolve to null, not quietly
  // inherit England's (or Italy's, or Denmark's) league statistics.
  assert.strictEqual(mapLeague('Premier League', 'Belarus'), null);
  assert.strictEqual(mapLeague('Championship', 'Wales'), null);
  assert.strictEqual(mapLeague('Super League', 'Malta'), null);
  assert.strictEqual(mapLeague('Serie A', 'Ecuador'), null);
});

test('name-only lookups keep the historical default (rows with no country)', () => {
  // A leagues row with a null country must degrade to the old behaviour rather
  // than dropping the fixture — but only when there is genuinely no country.
  assert.strictEqual(mapLeague('Premier League'), 'epl');
  assert.strictEqual(mapLeague('Championship'), 'e1');
  assert.strictEqual(mapLeague('Serie A'), 'seriea');
  assert.strictEqual(mapLeague('Bundesliga'), 'bundesliga');
  // country carried inside the name still works
  assert.strictEqual(mapLeague('Austria Bundesliga'), 'austria_bundesliga');
  assert.strictEqual(mapLeague('Brazil Serie A'), 'brazil_seriea');
});

test('Copa de la Liga is not swallowed by the Spanish La Liga pattern', () => {
  // "Copa de la Liga Profesional" contains the substring "la Liga".
  assert.strictEqual(mapLeague('Copa de la Liga Profesional', 'Argentina'),
                     'argentina_copadelaligaprofesional');
  assert.strictEqual(mapLeague('La Liga', 'Spain'), 'laliga');
});

test('a league we do not model returns null, not a wrong slug', () => {
  assert.strictEqual(mapLeague('FIFA World Cup', 'International'), null);
  assert.strictEqual(mapLeague('UEFA Champions League', 'Europe'), null);
  assert.strictEqual(mapLeague('Premier League', 'Belarus'), null);
  assert.strictEqual(mapLeague('', ''), null);
  assert.strictEqual(mapLeague(null, null), null);
});

// ── every slug produced must exist in the trained bundle ────────────────────
// A typo'd slug maps to no league_stats entry and silently falls back to the
// global prior — the fixture prices, but with the wrong league's baseline.

test('every mapped slug exists in lambda_bundle.json', () => {
  const bundlePath = path.join(__dirname, 'ensemble/models/lambda_bundle.json');
  if (!fs.existsSync(bundlePath)) { console.log('    (bundle absent — skipped)'); return; }
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const known = new Set(Object.keys(bundle.league_stats ?? {}));
  const produced = [
    ['Premier League', 'England'], ['Premier League', 'Russia'],
    ['Championship', 'England'], ['Championship', 'Scotland'],
    ['League One', 'England'], ['League One', 'Scotland'],
    ['League Two', 'England'], ['League Two', 'Scotland'],
    ['Premiership', 'Scotland'], ['National League', 'England'],
    ['Super League', 'Switzerland'], ['Challenge League', 'Switzerland'],
    ['Superliga', 'Denmark'], ['Veikkausliiga', 'Finland'],
    ['Premier Division', 'Ireland'], ['Liga I', 'Romania'],
    ['Liga Profesional Argentina', 'Argentina'],
    ['Copa de la Liga Profesional', 'Argentina'],
  ].map(([n, c]) => mapLeague(n, c));
  for (const slug of produced) {
    assert.ok(slug, 'expected a slug for every listed league');
    assert.ok(known.has(slug), `slug "${slug}" is not a league in the bundle`);
  }
});

console.log(`\n${passed} league-map test(s) passed`);
