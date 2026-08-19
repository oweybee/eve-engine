'use strict';

/**
 * engine.eloforecasts.test.js — what the forecast writer refuses to say.
 *
 * Every branch here is a decision about what MAY reach a reader, so every
 * branch is pinned. The asymmetry is the point: withholding shows a reader
 * nothing, which is safe, while a defaulted rating or a half-written vector
 * shows them a confident number that no model produced, which is not.
 */

const test = require('node:test');
const assert = require('node:assert');
const { forecastRow } = require('./computeEloForecasts');

const PARAMS = { drawAtParity: 0.26, drawSpread: 400, homeAdv: 80 };

const L = (theta) => ({ theta, source: 'league', nRatedOpponents: null, isUsable: true, minRatedOpponents: 4 });
const O = (theta, n) => ({ theta, source: 'opponents', nRatedOpponents: n, isUsable: n >= 4, minRatedOpponents: 4 });

const scale = new Map([
  ['arsenal', L(0)],
  ['bayern', L(-40)],
  ['shamrock', O(-300, 9)],
  ['hbtorshavn', O(-350, 2)],
]);

const ratings = new Map([
  ['arsenal', { elo: 1850, games: 400 }],
  ['bayern', { elo: 1900, games: 380 }],
  ['shamrock', { elo: 1600, games: 60 }],
  ['hbtorshavn', { elo: 1450, games: 40 }],
]);

const ctx = { ratings, scale, params: PARAMS };

const fixture = (over = {}) => ({
  match_id: 'm1',
  kickoff_at: '2026-08-25T18:00:00Z',
  home_name: 'Arsenal', away_name: 'Bayern Munich',
  home_key: 'arsenal', away_key: 'bayern',
  competition_is_domestic_league: false,
  status: 'placed', basis: 'league', unplaced_reason: null,
  ...over,
});

test('a placeable cross-league tie gets a probability vector that sums to one', () => {
  const row = forecastRow(fixture(), ctx);
  assert.strictEqual(row.status, 'forecast');
  assert.ok(Math.abs(row.p_home + row.p_draw + row.p_away - 1) < 1e-12,
    'the vector must sum to one — the database constraint rejects it otherwise');
  for (const p of [row.p_home, row.p_draw, row.p_away]) {
    assert.ok(p > 0 && p < 1, `${p} is not a probability`);
  }
});

test('the offsets are APPLIED, and recorded as the shift they caused', () => {
  const row = forecastRow(fixture(), ctx);
  // Arsenal is the reference (theta 0); Bayern carries -40.
  assert.strictEqual(row.theta_home, 0);
  assert.strictEqual(row.theta_away, -40);
  assert.strictEqual(row.elo_home, 1850);
  assert.strictEqual(row.elo_away, 1860);
  assert.strictEqual(row.cross_league, true);
});

test('a DOMESTIC fixture uses the raw ratings, because the offsets cancel', () => {
  const row = forecastRow(fixture({
    competition_is_domestic_league: true, basis: 'competition',
    away_name: 'Arsenal B', away_key: 'arsenal',
  }), ctx);
  assert.strictEqual(row.status, 'forecast');
  assert.strictEqual(row.theta_home, 0);
  assert.strictEqual(row.theta_away, 0);
  assert.strictEqual(row.cross_league, false);
  assert.strictEqual(row.basis, 'competition');
});

test('a domestic fixture is forecast even for a club with NO place on the scale', () => {
  // The competition supplies the context: both clubs are in the same league, so
  // whatever the offset is, it cancels. Refusing here would blank a domestic
  // board over a cross-league problem it does not have.
  const row = forecastRow(fixture({
    competition_is_domestic_league: true, basis: 'competition',
    home_key: 'unscaled_a', away_key: 'unscaled_b',
    home_name: 'Someone', away_name: 'Somebody',
  }), {
    ...ctx,
    ratings: new Map([
      ['unscaled_a', { elo: 1500, games: 40 }],
      ['unscaled_b', { elo: 1520, games: 40 }],
    ]),
  });
  assert.strictEqual(row.status, 'forecast');
});

test('the SQL verdict is honoured rather than re-derived', () => {
  const row = forecastRow(fixture({
    status: 'unplaced', basis: null,
    unplaced_reason: 'HB Torshavn has no place on the ELO scale',
  }), ctx);
  assert.strictEqual(row.status, 'withheld');
  assert.strictEqual(row.withheld_code, 'unplaced');
  assert.match(row.withheld_reason, /HB Torshavn/);
});

test('an unplaced fixture with no reason still carries one, never a bare null', () => {
  // The database rejects a withheld row with no code, and a reason nobody
  // wrote is the silence this table exists to end.
  const row = forecastRow(fixture({ status: 'unplaced', unplaced_reason: null }), ctx);
  assert.strictEqual(row.withheld_code, 'unplaced');
  assert.ok(row.withheld_reason && row.withheld_reason.length > 0);
});

test('A MISSING RATING IS WITHHELD, NOT DEFAULTED TO 1500', () => {
  // A defaulted rating is the absence of a forecast wearing a number, and it
  // would be scored as though it were a read.
  const row = forecastRow(fixture({ away_key: 'nobody', away_name: 'Unknown FC' }), ctx);
  assert.strictEqual(row.status, 'withheld');
  assert.strictEqual(row.withheld_code, 'no_rating');
  assert.match(row.withheld_reason, /Unknown FC/);
  assert.strictEqual(row.p_home, null);
  assert.strictEqual(row.p_draw, null);
  assert.strictEqual(row.p_away, null);
});

test('both clubs unrated are both named', () => {
  const row = forecastRow(fixture({
    home_key: 'nobody1', away_key: 'nobody2',
    home_name: 'A FC', away_name: 'B FC',
  }), ctx);
  assert.match(row.withheld_reason, /A FC and B FC have/);
});

test('a thinly-placed club is refused by name, with its opponent count', () => {
  const row = forecastRow(fixture({
    away_key: 'hbtorshavn', away_name: 'HB Torshavn', status: 'placed',
  }), ctx);
  assert.strictEqual(row.status, 'withheld');
  assert.strictEqual(row.withheld_code, 'club_thinly_placed');
  assert.match(row.withheld_reason, /2 rated opponent/);
});

test('a club placed by ENOUGH rated opponents is forecast', () => {
  const row = forecastRow(fixture({
    away_key: 'shamrock', away_name: 'Shamrock Rovers',
  }), ctx);
  assert.strictEqual(row.status, 'forecast');
  assert.strictEqual(row.basis, 'opponents');
});

test('AN EMPTY SCALE REFUSES CROSS-LEAGUE AND STILL SERVES DOMESTIC', () => {
  // loadTeamScale returns an empty map on a failed read rather than throwing.
  // A degraded run must not become a silent one, and must not blank the
  // fixtures the scale was never needed for.
  const bare = { ...ctx, scale: new Map() };
  assert.strictEqual(forecastRow(fixture(), bare).status, 'withheld');
  assert.strictEqual(
    forecastRow(fixture({ competition_is_domestic_league: true }), bare).status,
    'forecast');
});

test('every withheld row carries a code, and every forecast row carries none', () => {
  const cases = [
    fixture(),
    fixture({ status: 'unplaced' }),
    fixture({ away_key: 'nobody' }),
    fixture({ away_key: 'hbtorshavn' }),
    fixture({ competition_is_domestic_league: true }),
  ];
  for (const f of cases) {
    const row = forecastRow(f, ctx);
    if (row.status === 'forecast') {
      assert.strictEqual(row.withheld_code, null);
      assert.strictEqual(row.withheld_reason, null);
    } else {
      assert.ok(row.withheld_code, 'a withheld row must say why — the CHECK constraint requires it');
    }
  }
});

test('a forecast never carries a partial vector', () => {
  // The shape the database constraint rejects: it must be impossible to
  // produce here in the first place.
  for (const f of [fixture(), fixture({ competition_is_domestic_league: true })]) {
    const row = forecastRow(f, ctx);
    const legs = [row.p_home, row.p_draw, row.p_away];
    const present = legs.filter(p => p != null).length;
    assert.ok(present === 0 || present === 3, 'all three legs or none');
  }
});
