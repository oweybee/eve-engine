'use strict';

/**
 * engine.leaguestrength.test.js — the offsets, and the refusals.
 *
 * The refusals are the point of the module, so most of these tests are about
 * what it declines to do. A cross-league pair with no offset must come back
 * null; returning 0 would assert that a Chinese Super League club and a Premier
 * League club on the same rating are equally good, which is wrong by roughly
 * two hundred points and would never look wrong on screen.
 */

const test = require('node:test');
const assert = require('node:assert');
const { teamKey } = require('./lib/teamKey');
const { adjustPair, comparable, refusalReason, USABLE } = require('./lib/leagueStrength');
const { eloProbs } = require('./lib/eloProbs');

const EPL = 'epl-uuid', BUND = 'bund-uuid', MLS = 'mls-uuid', L2 = 'ligue2-uuid';
const strength = new Map([
  [EPL,  { status: 'reference', theta: 0,     se: 18.7 }],
  [BUND, { status: 'fitted',    theta: -36.5, se: 20.3 }],
  [MLS,  { status: 'not_estimable', theta: null, se: null }],
  [L2,   { status: 'insufficient',  theta: null, se: null }],
]);

// ── the key ────────────────────────────────────────────────────────────────
test('teamKey folds accents to the ASCII letter rather than deleting it', () => {
  for (const [a, b] of [
    ['Atlético Madrid', 'Atletico Madrid'],
    ['Saint-Étienne', 'Saint Etienne'],
    ['Borussia Mönchengladbach', 'Borussia Monchengladbach'],
    ['Leganés', 'Leganes'],
    ['SpVgg Greuther Fürth', 'SpVgg Greuther Furth'],
    ['Curaçao', 'Curacao'],
    ['Örgryte IS', 'Orgryte IS'],
  ]) {
    assert.equal(teamKey(a), teamKey(b), `${a} should key as ${b}`);
  }
});

test('teamKey folds a leading capital accent — the case that escaped the SQL view', () => {
  assert.equal(teamKey('Örgryte IS'), 'orgryteis');
});

test('teamKey does NOT join genuinely different names', () => {
  // Bayern München / Bayern Munich is a translation, not an accent variant, and
  // belongs in team_aliases. No folding rule should silently join them.
  assert.notEqual(teamKey('Bayern München'), teamKey('Bayern Munich'));
  assert.notEqual(teamKey('Wolves'), teamKey('Wolverhampton Wanderers'));
});

test('teamKey returns empty string for a missing name, never a key', () => {
  for (const v of [null, undefined, '', '   ', '!!!']) assert.equal(teamKey(v), '');
});

// ── adjusting ──────────────────────────────────────────────────────────────
test('a same-league pair is returned untouched and never consults the table', () => {
  const out = adjustPair(new Map(), { eloHome: 1700, leagueHome: MLS, eloAway: 1600, leagueAway: MLS });
  assert.deepEqual(out, { eloHome: 1700, eloAway: 1600, crossLeague: false });
});

test('a cross-league pair has each side shifted by its own offset', () => {
  const out = adjustPair(strength, { eloHome: 1700, leagueHome: EPL, eloAway: 1700, leagueAway: BUND });
  assert.equal(out.eloHome, 1700);
  assert.equal(out.eloAway, 1663.5);
  assert.equal(out.crossLeague, true);
});

test('the offset changes the forecast, not just the arithmetic', () => {
  const raw  = eloProbs(1700, 1700);
  const adj  = adjustPair(strength, { eloHome: 1700, leagueHome: EPL, eloAway: 1700, leagueAway: BUND });
  const with_ = eloProbs(adj.eloHome, adj.eloAway);
  assert.ok(with_.pHome > raw.pHome, 'the Premier League side should gain');
  assert.ok(with_.pAway < raw.pAway, 'the Bundesliga side should lose');
});

// ── refusing ───────────────────────────────────────────────────────────────
test('a not_estimable league refuses the cross-league pair', () => {
  assert.equal(adjustPair(strength, { eloHome: 1620, leagueHome: MLS, eloAway: 1620, leagueAway: EPL }), null);
  assert.equal(adjustPair(strength, { eloHome: 1620, leagueHome: EPL, eloAway: 1620, leagueAway: MLS }), null);
});

test('an insufficient league refuses too — a wide interval is not an offset', () => {
  assert.equal(adjustPair(strength, { eloHome: 1600, leagueHome: L2, eloAway: 1600, leagueAway: EPL }), null);
});

test('an unknown league refuses rather than defaulting to zero', () => {
  assert.equal(adjustPair(strength, { eloHome: 1600, leagueHome: 'never-heard-of-it', eloAway: 1600, leagueAway: EPL }), null);
});

test('an empty table refuses every cross-league pair', () => {
  assert.equal(adjustPair(new Map(), { eloHome: 1600, leagueHome: EPL, eloAway: 1600, leagueAway: BUND }), null);
});

test('a missing rating refuses before the offsets are even looked at', () => {
  assert.equal(adjustPair(strength, { eloHome: null, leagueHome: EPL, eloAway: 1600, leagueAway: BUND }), null);
  assert.equal(adjustPair(strength, { eloHome: 1600, leagueHome: EPL, eloAway: NaN, leagueAway: BUND }), null);
});

test('comparable agrees with adjustPair on every case', () => {
  const cases = [[EPL, BUND, true], [EPL, MLS, false], [MLS, MLS, true], [L2, EPL, false], [EPL, 'x', false]];
  for (const [a, b, want] of cases) {
    assert.equal(comparable(strength, a, b), want, `${a} vs ${b}`);
    assert.equal(adjustPair(strength, { eloHome: 1600, leagueHome: a, eloAway: 1600, leagueAway: b }) !== null, want);
  }
});

test('refusalReason names the side and the status, and is null when there is none', () => {
  assert.equal(refusalReason(strength, EPL, BUND), null);
  assert.equal(refusalReason(strength, MLS, MLS), null);
  assert.match(refusalReason(strength, MLS, EPL), /home league is not_estimable/);
  assert.match(refusalReason(strength, EPL, L2),  /away league is insufficient/);
  assert.match(refusalReason(strength, 'x', EPL), /home league has no league_strength row/);
});

test('only reference and fitted are usable statuses', () => {
  assert.deepEqual([...USABLE].sort(), ['fitted', 'reference']);
});
