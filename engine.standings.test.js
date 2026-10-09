/**
 * engine.standings.test.js — the league table parser.
 * Run: node engine.standings.test.js
 *
 * THE THREE FAILURES THESE PIN, all of them silent:
 *
 *   A TABLE WITH ROWS MISSING. A reader cannot tell one from a correct table
 *   and would simply believe it, so a row is dropped only when it is missing
 *   something the row cannot exist without, and every other field degrades to
 *   a zero or a null rather than taking the row with it.
 *
 *   A GROUP LABEL THAT IS THE COMPETITION. The vendor labels a plain league's
 *   only table with the league's own name, which would print "3rd in Premier
 *   League group" over a table already headed Premier League.
 *
 *   A POSITION WE DERIVED. The vendor's rank is carried through untouched. A
 *   table re-sorted on points here would disagree with the official one
 *   wherever a deduction or a tie-break applies, which is the whole reason
 *   this is ingested rather than computed.
 */
'use strict';
const assert = require('assert');
const { parseStandings, groupLabelFor, withTeamIds, currentSeasonYear, tablesIn } = require('./fetchStandings');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

/** One row in the vendor's shape. */
const row = (over = {}) => ({
  rank: 1,
  team: { id: 42, name: 'Northfield United', logo: 'https://x/42.png' },
  points: 24,
  group: 'Premier League',
  form: 'WWDLW',
  all: { played: 10, win: 7, draw: 3, lose: 0, goals: { for: 21, against: 6 } },
  ...over,
});

const payload = (tables, leagueName = 'Premier League') => ({
  response: [{ league: { name: leagueName, standings: tables } }],
});

console.log('\nparseStandings');

test('reads one ladder into one row per club', () => {
  const out = parseStandings(payload([[row(), row({ rank: 2, team: { id: 7, name: 'Castleton' } })]]));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].team_name, 'Northfield United');
  assert.strictEqual(out[0].api_team_id, 42);
  assert.strictEqual(out[0].position, 1);
  assert.strictEqual(out[0].points, 24);
  assert.strictEqual(out[0].played, 10);
  assert.strictEqual(out[0].goals_for, 21);
  assert.strictEqual(out[0].goals_against, 6);
  assert.strictEqual(out[0].form, 'WWDLW');
  // THE EMPTY STRING, NOT NULL: the group is part of the primary key from
  // migration 135 and a nullable column cannot carry one.
  assert.strictEqual(out[0].group_label, '');
});

test('carries the vendor rank rather than re-deriving it from points', () => {
  // A DEDUCTED SIDE: more points than the club above it and ranked below. A
  // table sorted on points here would swap them and disagree with the
  // governing body, which is the failure this ingest exists to avoid.
  const out = parseStandings(payload([[
    row({ rank: 1, points: 20, team: { id: 1, name: 'Clean' } }),
    row({ rank: 2, points: 28, team: { id: 2, name: 'Deducted' } }),
  ]]));
  assert.strictEqual(out[0].position, 1);
  assert.strictEqual(out[0].points, 20);
  assert.strictEqual(out[1].position, 2);
  assert.strictEqual(out[1].points, 28);
});

test('keeps every group of a group phase, each with its own label', () => {
  const out = parseStandings(payload([
    [row({ group: 'Group A', team: { id: 1, name: 'A1' } })],
    [row({ group: 'Group B', team: { id: 2, name: 'B1' } })],
  ], 'Champions League'));
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((r) => r.group_label), ['Group A', 'Group B']);
});

test('drops a row that has no rank, no id or no name, and keeps the rest', () => {
  const out = parseStandings(payload([[
    row(),
    row({ rank: null, team: { id: 8, name: 'No rank' } }),
    row({ rank: 3, team: { id: null, name: 'No id' } }),
    row({ rank: 4, team: { id: 9, name: '   ' } }),
  ]]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].api_team_id, 42);
});

test('keeps one club twice when a competition puts it in two of its tables', () => {
  // THE 9 OCT PRODUCTION FAILURE, as a test. Veikkausliiga sends a regular
  // season and a championship round drawn from it, so the same club arrives
  // twice in one league-season. Both rows are real — the championship-round
  // position is the one a reader wants in October and the regular-season
  // position is how the club got there — so both are kept, and migration 135
  // put the group in the key so they can be.
  const out = parseStandings(payload([
    [row({ rank: 3, group: 'Regular Season', team: { id: 42, name: 'HJK' } })],
    [row({ rank: 1, group: 'Championship Round', team: { id: 42, name: 'HJK' } })],
  ], 'Veikkausliiga'));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].api_team_id, 42);
  assert.strictEqual(out[1].api_team_id, 42);
  assert.deepStrictEqual(out.map((r) => r.group_label), ['Regular Season', 'Championship Round']);
  // AND THE KEY SEPARATES THEM. Same league, season and club; different table.
  assert.strictEqual(new Set(out.map((r) => r.group_label)).size, 2);
});

test('degrades a missing figure to zero rather than losing the club', () => {
  // A SIDE THAT HAS NOT PLAYED has no `all` block in some responses. It is
  // still in the table and still has a position, so it is still a row.
  const out = parseStandings(payload([[row({ all: undefined, points: 0, form: null })]]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].played, 0);
  assert.strictEqual(out[0].goals_against, 0);
  assert.strictEqual(out[0].form, null);
});

test('returns nothing at all for a response with no table in it', () => {
  // BETWEEN SEASONS, OR OUTSIDE THE SUBSCRIPTION. Empty is a real answer and
  // the caller leaves the stored table alone for it.
  assert.deepStrictEqual(parseStandings({ response: [] }), []);
  assert.deepStrictEqual(parseStandings({}), []);
  assert.deepStrictEqual(parseStandings(payload(null)), []);
  assert.deepStrictEqual(parseStandings(payload([null, 'nope'])), []);
});

console.log('\ngroupLabelFor');

test('treats the competition’s own name as no group at all', () => {
  // NULL HERE, '' AT THE WRITER. This function answers "is this a real group";
  // the empty-string sentinel is the storage layer's business and the caller
  // applies it, so the test for the question stays about the question.
  assert.strictEqual(groupLabelFor('Premier League', 'Premier League'), null);
  assert.strictEqual(groupLabelFor('  premier league  ', 'Premier League'), null);
});

test('keeps a real group', () => {
  assert.strictEqual(groupLabelFor('Group C', 'Champions League'), 'Group C');
  assert.strictEqual(groupLabelFor('Championship Round', 'Eliteserien'), 'Championship Round');
});

test('is null for an absent label', () => {
  assert.strictEqual(groupLabelFor(null, 'X'), null);
  assert.strictEqual(groupLabelFor('   ', 'X'), null);
});

console.log('\ntablesIn');

test('counts the tables in a competition, not the rows', () => {
  assert.strictEqual(tablesIn([{ group_label: '' }, { group_label: '' }]), 1);
  assert.strictEqual(tablesIn([{ group_label: 'Group A' }, { group_label: 'Group B' }]), 2);
  assert.strictEqual(tablesIn([]), 0);
});

console.log('\nwithTeamIds');

test('matches a club on the vendor id and leaves the rest null', () => {
  const rows = parseStandings(payload([[
    row({ team: { id: 42, name: 'Known' } }),
    row({ rank: 2, team: { id: 99, name: 'Unknown' } }),
  ]]));
  const out = withTeamIds(rows, new Map([['42', 'uuid-known']]));
  assert.strictEqual(out[0].team_id, 'uuid-known');
  assert.strictEqual(out[1].team_id, null);
  // AND THE UNMATCHED CLUB IS STILL A ROW. Half our teams carry no external
  // id, so dropping the unmatched ones would halve a country's table.
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].team_name, 'Unknown');
});

test('never matches on the club name', () => {
  // `buildTeamAliases` exists because club names do not match across feeds. A
  // name join would put another club's league position on a fixture card.
  const rows = parseStandings(payload([[row({ team: { id: 99, name: 'Known' } })]]));
  const out = withTeamIds(rows, new Map([['42', 'uuid-known']]));
  assert.strictEqual(out[0].team_id, null);
});

console.log('\ncurrentSeasonYear');

test('is the START year, matching backfillSeasonFixtures', () => {
  assert.strictEqual(currentSeasonYear(new Date('2026-10-09T00:00:00Z')), 2026);
  assert.strictEqual(currentSeasonYear(new Date('2026-07-01T00:00:00Z')), 2026);
  assert.strictEqual(currentSeasonYear(new Date('2026-06-30T00:00:00Z')), 2025);
  assert.strictEqual(currentSeasonYear(new Date('2027-01-15T00:00:00Z')), 2026);
});

console.log(`\n${passed} passed`);
