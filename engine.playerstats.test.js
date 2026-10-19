/**
 * engine.playerstats.test.js — /fixtures/players ingest (backfillPlayerStats.js).
 * Run: node engine.playerstats.test.js
 *
 * Pure logic only: vendor number parsing, home/away orientation, which players
 * become rows, and the per-fixture coverage flags player_form() relies on to
 * tell "0 shots" from "not reported".
 */
'use strict';
const assert = require('assert');
const { toNum, toInt, orientPlayerBlocks, playerRows, fixtureCoverage, logRow, quotaTooLow } =
  require('./backfillPlayerStats');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const stat = (o = {}) => ({
  games: { minutes: 90, number: 9, position: 'F', rating: '7.3', captain: false, substitute: false, ...(o.games || {}) },
  offsides: null,
  shots: { total: null, on: null, ...(o.shots || {}) },
  goals: { total: null, conceded: 0, assists: null, saves: null, ...(o.goals || {}) },
  passes: { total: 20, key: 1, accuracy: '15', ...(o.passes || {}) },
  tackles: { total: null, blocks: null, interceptions: null },
  duels: { total: 5, won: 2 },
  dribbles: { attempts: null, success: null, past: null },
  fouls: { drawn: null, committed: null, ...(o.fouls || {}) },
  cards: { yellow: 0, red: 0, ...(o.cards || {}) },
  penalty: { won: null, commited: null, scored: 0, missed: 0, saved: null },
});
const block = (id, name, players) => ({ team: { id, name }, players });
const pl = (id, name, o) => ({ player: { id, name }, statistics: [stat(o)] });

console.log('vendor numbers');
test('numbers, numeric strings and percentages parse; junk is null, never NaN', () => {
  assert.strictEqual(toNum('7.3'), 7.3);
  assert.strictEqual(toNum('85%'), 85);
  assert.strictEqual(toNum(4), 4);
  assert.strictEqual(toNum(null), null);
  assert.strictEqual(toNum(''), null);
  assert.strictEqual(toNum('-'), null);
  assert.strictEqual(toInt('6.6'), 7);
});

console.log('orientation');
const resp = [block(47, 'Tottenham', []), block(1346, 'Coventry', [])];
test('exact API team ids win', () => {
  const o = orientPlayerBlocks(resp, { homeApiId: '47', awayApiId: '1346' });
  assert.strictEqual(o.by, 'team_id');
  assert.deepStrictEqual(o.blocks.map(b => b.side), ['home', 'away']);
});
test('a reversed payload is caught by id, not trusted by order', () => {
  const o = orientPlayerBlocks(resp, { homeApiId: 1346, awayApiId: 47 });
  assert.strictEqual(o.by, 'team_id');
  assert.deepStrictEqual(o.blocks.map(b => b.side), ['away', 'home']);
});
test('names are the fallback when ids are missing', () => {
  const o = orientPlayerBlocks(resp, { homeName: 'Coventry City', awayName: 'Tottenham Hotspur' });
  assert.strictEqual(o.by, 'name');
  assert.deepStrictEqual(o.blocks.map(b => b.side), ['away', 'home']);
});
test('order is the last resort, and says so', () => {
  assert.strictEqual(orientPlayerBlocks(resp, {}).by, 'order');
});
test('an empty response is null, not a fixture with no players', () => {
  assert.strictEqual(orientPlayerBlocks([], {}), null);
  assert.strictEqual(orientPlayerBlocks(undefined, {}), null);
});

console.log('rows');
const meta = { fixtureId: 123, matchId: 'm', leagueId: 'l', kickoffAt: '2026-10-18T14:00:00Z' };
test('unused subs (null or 0 minutes) are not rows', () => {
  const o = orientPlayerBlocks([
    block(47, 'Spurs', [pl(1, 'A', {}), pl(2, 'B', { games: { minutes: null } }), pl(3, 'C', { games: { minutes: 0 } })]),
    block(1346, 'Cov', []),
  ], { homeApiId: 47, awayApiId: 1346 });
  const rows = playerRows(meta, o);
  assert.deepStrictEqual(rows.map(r => r.player_id), [1]);
  assert.strictEqual(rows[0].team_side, 'home');
  assert.strictEqual(rows[0].fixture_id, '123');
  assert.strictEqual(rows[0].rating, 7.3);
});
test('the vendor misspelling penalty.commited is read', () => {
  const o = orientPlayerBlocks([block(47, 'S', [{ player: { id: 9, name: 'X' },
    statistics: [{ ...stat(), penalty: { commited: 1 } }] }])], {});
  assert.strictEqual(playerRows(meta, o)[0].pen_committed, 1);
});

console.log('coverage: absent is not zero');
test('shots count as reported only when somebody has a non-null total', () => {
  const none = [{ shots_total: null, rating: 7 }, { shots_total: null, rating: 6 }];
  const some = [{ shots_total: null, rating: 7 }, { shots_total: 3, rating: 6 }];
  assert.strictEqual(fixtureCoverage(none).has_shots, false);
  assert.strictEqual(fixtureCoverage(some).has_shots, true);
});
test('zero-filled cards with no player detail are NOT coverage', () => {
  const bare = [{ yellow: 0, red: 0, rating: null, passes_total: null }];
  assert.strictEqual(fixtureCoverage(bare).has_cards, false);
  const real = [{ yellow: 0, red: 0, rating: 6.9, passes_total: null }];
  assert.strictEqual(fixtureCoverage(real).has_cards, true);
});
test('fouls need detail and a non-null value', () => {
  assert.strictEqual(fixtureCoverage([{ rating: 7, fouls_committed: null, fouls_drawn: null }]).has_fouls, false);
  assert.strictEqual(fixtureCoverage([{ rating: 7, fouls_committed: 2 }]).has_fouls, true);
});
test('an empty fixture logs players=0 with every family off, so it is not asked again', () => {
  const l = logRow(5, [], undefined);
  assert.deepStrictEqual([l.players, l.has_shots, l.has_cards, l.has_fouls, l.has_detail, l.oriented_by], [0, false, false, false, false, null]);
});

test('detail coverage needs a pass count, a rating alone is not enough', () => {
  assert.strictEqual(fixtureCoverage([{ rating: 7, passes_total: null }]).has_detail, false);
  assert.strictEqual(fixtureCoverage([{ rating: 7, passes_total: 31, saves: null }]).has_detail, true);
});

console.log('quota');
test('stops under the reserve, carries on above it or with no reading', () => {
  assert.strictEqual(quotaTooLow({ remainingDay: 19999 }, 20000), true);
  assert.strictEqual(quotaTooLow({ remainingDay: 20001 }, 20000), false);
  assert.strictEqual(quotaTooLow(null, 20000), false);
});

console.log(`\n${passed} passed`);
