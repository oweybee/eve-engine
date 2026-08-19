'use strict';

/**
 * engine.leaguestrength.test.js — the offsets, the competition rule, and the
 * refusals.
 *
 * Most of these are about what the module DECLINES to do, because that is what
 * it is for. Two failure modes matter and they are not symmetrical: refusing a
 * pair shows the reader nothing, which is safe; shifting a domestic fixture by
 * a hundred rating points because a promoted club was read as still being in
 * the division below shows the reader a confident wrong number, which is not.
 */

const test = require('node:test');
const assert = require('node:assert');
const { teamKey } = require('./lib/teamKey');
const {
  adjustPair, comparable, refusalReason, scaleFor,
  USABLE, DEFAULT_MIN_RATED_OPPONENTS,
} = require('./lib/leagueStrength');
const { eloProbs } = require('./lib/eloProbs');

// arsenal: Premier League (reference). bayern: Bundesliga. monza: Serie B last
// season, Serie A this one. shamrock: no domestic league, placed by 9 rated
// opponents. hbtorshavn: no domestic league, only 2 rated opponents.
const scale = new Map([
  ['arsenal',    { theta:    0.0, source: 'league',    nRatedOpponents: null }],
  ['bayern',     { theta:  -38.1, source: 'league',    nRatedOpponents: null }],
  ['inter',      { theta:  -68.3, source: 'league',    nRatedOpponents: null }],
  ['monza',      { theta: -238.1, source: 'league',    nRatedOpponents: null }],
  ['shamrock',   { theta: -290.0, source: 'opponents', nRatedOpponents: 9 }],
  ['hbtorshavn', { theta: -150.0, source: 'opponents', nRatedOpponents: 2 }],
]);
const DOM = { competitionIsDomesticLeague: true };
const CUP = { competitionIsDomesticLeague: false };

// ── the key ────────────────────────────────────────────────────────────────
test('teamKey folds accents to the ASCII letter rather than deleting it', () => {
  for (const [a, b] of [
    ['Atlético Madrid', 'Atletico Madrid'],
    ['Saint-Étienne', 'Saint Etienne'],
    ['Borussia Mönchengladbach', 'Borussia Monchengladbach'],
    ['Leganés', 'Leganes'],
    ['SpVgg Greuther Fürth', 'SpVgg Greuther Furth'],
    ['Curaçao', 'Curacao'],
  ]) assert.equal(teamKey(a), teamKey(b), `${a} should key as ${b}`);
});

test('teamKey folds a LEADING capital accent — the bug that shipped twice', () => {
  assert.equal(teamKey('Örgryte IS'), 'orgryteis');
});

test('teamKey does NOT join genuinely different names', () => {
  assert.notEqual(teamKey('Bayern München'), teamKey('Bayern Munich'));
  assert.notEqual(teamKey('Wolves'), teamKey('Wolverhampton Wanderers'));
});

test('teamKey returns empty string for a missing name, never a key', () => {
  for (const v of [null, undefined, '', '   ', '!!!']) assert.equal(teamKey(v), '');
});

// ── the competition rule ───────────────────────────────────────────────────
test('a domestic league fixture is returned untouched, whatever the clubs say', () => {
  // Inter v Monza IS a Serie A fixture. Monza's stored offset is League Two-ish
  // because it last completed a season below; it must not be applied.
  const out = adjustPair(scale, { eloHome: 1700, eloAway: 1500, homeKey: 'inter', awayKey: 'monza', ...DOM });
  assert.deepEqual(out, { eloHome: 1700, eloAway: 1500, crossLeague: false, basis: 'competition' });
});

test('the competition rule does not even need the clubs to be in the table', () => {
  const out = adjustPair(new Map(), { eloHome: 1600, eloAway: 1600, homeKey: 'who', awayKey: 'dis', ...DOM });
  assert.equal(out.crossLeague, false);
  assert.equal(out.eloHome, 1600);
});

test('omitting the competition flag REFUSES rather than assuming', () => {
  // Assuming either way is worse than silence: assume cross-league and a
  // domestic fixture is shifted; assume domestic and a European tie is not.
  assert.equal(adjustPair(scale, { eloHome: 1700, eloAway: 1500, homeKey: 'inter', awayKey: 'monza' }), null);
  assert.equal(adjustPair(scale, { eloHome: 1700, eloAway: 1500, homeKey: 'inter', awayKey: 'monza',
                                   competitionIsDomesticLeague: 'yes' }), null);
  assert.equal(comparable(scale, { homeKey: 'inter', awayKey: 'monza' }), false);
  assert.match(refusalReason(scale, { homeKey: 'inter', awayKey: 'monza' }), /was not supplied/);
});

// ── adjusting a real cross-league pair ─────────────────────────────────────
test('a European tie shifts each side by its own offset', () => {
  const out = adjustPair(scale, { eloHome: 1700, eloAway: 1700, homeKey: 'arsenal', awayKey: 'bayern', ...CUP });
  assert.equal(out.eloHome, 1700);
  assert.equal(out.eloAway, 1661.9);
  assert.equal(out.crossLeague, true);
  assert.equal(out.basis, 'league');
});

test('the offset changes the forecast, not just the arithmetic', () => {
  const raw = eloProbs(1700, 1700);
  const adj = adjustPair(scale, { eloHome: 1700, eloAway: 1700, homeKey: 'arsenal', awayKey: 'bayern', ...CUP });
  const out = eloProbs(adj.eloHome, adj.eloAway);
  assert.ok(out.pHome > raw.pHome, 'the Premier League side should gain');
  assert.ok(out.pAway < raw.pAway, 'the Bundesliga side should lose');
});

test('an opponent-derived club is usable and is labelled as such', () => {
  const out = adjustPair(scale, { eloHome: 1600, eloAway: 1700, homeKey: 'shamrock', awayKey: 'arsenal', ...CUP });
  assert.equal(out.eloHome, 1310);
  assert.equal(out.basis, 'opponents', 'a derived side must not be reported as fitted');
});

// ── refusing ───────────────────────────────────────────────────────────────
test('a club placed by too few opponents is refused', () => {
  assert.equal(adjustPair(scale, { eloHome: 1600, eloAway: 1700, homeKey: 'hbtorshavn', awayKey: 'arsenal', ...CUP }), null);
  assert.match(refusalReason(scale, { homeKey: 'hbtorshavn', awayKey: 'arsenal', ...CUP }),
    /home club is placed only by 2 rated opponent/);
});

test('the opponent gate is tunable, and the default is four', () => {
  assert.equal(DEFAULT_MIN_RATED_OPPONENTS, 4);
  const out = adjustPair(scale, { eloHome: 1600, eloAway: 1700, homeKey: 'hbtorshavn',
                                  awayKey: 'arsenal', minRatedOpponents: 2, ...CUP });
  assert.equal(out.eloHome, 1450);
});

test('an unknown club refuses rather than defaulting to zero', () => {
  assert.equal(adjustPair(scale, { eloHome: 1600, eloAway: 1700, homeKey: 'nosuchclub', awayKey: 'arsenal', ...CUP }), null);
  assert.match(refusalReason(scale, { homeKey: 'nosuchclub', awayKey: 'arsenal', ...CUP }),
    /home club has no place on the global scale/);
});

test('an empty table refuses every cross-league pair', () => {
  assert.equal(adjustPair(new Map(), { eloHome: 1600, eloAway: 1600, homeKey: 'arsenal', awayKey: 'bayern', ...CUP }), null);
});

test('a missing rating refuses before anything is looked up', () => {
  assert.equal(adjustPair(scale, { eloHome: null, eloAway: 1600, homeKey: 'arsenal', awayKey: 'bayern', ...DOM }), null);
  assert.equal(adjustPair(scale, { eloHome: 1600, eloAway: NaN, homeKey: 'arsenal', awayKey: 'bayern', ...DOM }), null);
});

test('comparable and refusalReason agree with adjustPair on every case', () => {
  const cases = [
    [{ homeKey: 'arsenal', awayKey: 'bayern', ...CUP }, true],
    [{ homeKey: 'arsenal', awayKey: 'hbtorshavn', ...CUP }, false],
    [{ homeKey: 'shamrock', awayKey: 'arsenal', ...CUP }, true],
    [{ homeKey: 'nope', awayKey: 'arsenal', ...CUP }, false],
    [{ homeKey: 'inter', awayKey: 'monza', ...DOM }, true],
    [{ homeKey: 'nope', awayKey: 'nope2', ...DOM }, true],
  ];
  for (const [args, want] of cases) {
    assert.equal(comparable(scale, args), want, JSON.stringify(args));
    assert.equal(adjustPair(scale, { eloHome: 1600, eloAway: 1600, ...args }) !== null, want);
    assert.equal(refusalReason(scale, args) === null, want);
  }
});

test('scaleFor applies the opponent gate but never gates a fitted league', () => {
  assert.equal(scaleFor(scale, 'arsenal', 999)?.theta, 0.0);
  assert.equal(scaleFor(scale, 'shamrock', 9)?.theta, -290);
  assert.equal(scaleFor(scale, 'shamrock', 10), null);
});

test('only reference and fitted are usable league statuses', () => {
  assert.deepEqual([...USABLE].sort(), ['fitted', 'reference']);
});
