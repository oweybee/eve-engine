/**
 * engine.follows.test.js — settleFollows.js (the Following tab, migration 180).
 * Run: node engine.follows.test.js
 *
 * The settlement RULE is in the database (follow_measure / settle_follows) and
 * was verified there against a real settled fixture. What lives in JS is the
 * copy a member reads in a DM, when a fixture is ready to ask the vendor about,
 * and how a refused DM is recorded. Those are tested here, plus a source check
 * that nobody re-implements the rule in this file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { followLabel, alertText, lineWords, readyToFetch, dmFailureNote, liveRows, FETCH_AFTER_KICKOFF_MIN } = require('./settleFollows');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const base = { home_name: 'Arsenal', away_name: 'Fulham', match_id: 'm1' };

console.log('labels');
test('a whole-number line reads as N+', () => assert.strictEqual(lineWords('gte', 2), '2+'));
test('a .5 line reads Over / Under', () => {
  assert.strictEqual(lineWords('over', 9.5), 'Over 9.5');
  assert.strictEqual(lineWords('under', '2.5'), 'Under 2.5');
});
test('a player follow names the player first', () => {
  assert.strictEqual(followLabel({ ...base, subject: 'player', player_name: 'Bukayo Saka', stat: 'shots_on_target', comparator: 'gte', line: 1 }),
    'Bukayo Saka, on target 1+');
});
test('a match follow reads as the market', () => {
  assert.strictEqual(followLabel({ ...base, subject: 'match', stat: 'corners', comparator: 'over', line: 9.5 }), 'Over 9.5 corners');
});
test('a team follow names the team', () => {
  assert.strictEqual(followLabel({ ...base, subject: 'home', stat: 'cards', comparator: 'under', line: 2.5 }), 'Arsenal Under 2.5 cards');
  assert.strictEqual(followLabel({ ...base, subject: 'away', stat: 'goals', comparator: 'gte', line: 2 }), 'Fulham goals 2+');
});
test('BTTS has its own words', () => {
  assert.strictEqual(followLabel({ ...base, subject: 'match', stat: 'btts', comparator: 'gte', line: 1 }), 'Both teams to score');
  assert.strictEqual(followLabel({ ...base, subject: 'match', stat: 'btts', comparator: 'under', line: 0.5 }), 'Both teams to score: No');
});

console.log('the DM');
const dm = alertText({ ...base, subject: 'player', player_name: 'Bukayo Saka', stat: 'shots_on_target', comparator: 'gte', line: 1, progress: 2 });
test('says what landed, with the count', () => assert.ok(dm.startsWith('Landed: Bukayo Saka, on target 1+ (2)')));
test('names the match and links the match page', () => {
  assert.ok(dm.includes('Arsenal v Fulham'));
  assert.ok(dm.includes('https://maxedge.live/match/m1'));
});
test('carries the compliance line and no price', () => {
  assert.ok(dm.endsWith('18+ | BeGambleAware'));
  assert.ok(!/\d+\.\d{2}\b|odds|@/i.test(dm.replace('maxedge.live', '')), 'no price in a follow alert');
});
test('no em dash anywhere in member copy', () => assert.ok(!dm.includes('—')));

console.log('timing and failures');
const now = Date.parse('2026-10-24T18:00:00Z');
test(`a fixture is not asked about until ${FETCH_AFTER_KICKOFF_MIN} minutes after kickoff`, () => {
  assert.strictEqual(readyToFetch({ kickoff_at: '2026-10-24T16:00:00Z' }, now), false);
  assert.strictEqual(readyToFetch({ kickoff_at: '2026-10-24T15:00:00Z' }, now), true);
  assert.strictEqual(readyToFetch({ kickoff_at: null }, now), false);
});
test('after the first half hour it asks once an hour, not every run', () => {
  const late = Date.parse('2026-10-24T22:20:00Z');
  assert.strictEqual(readyToFetch({ kickoff_at: '2026-10-24T15:00:00Z' }, late), false);
  assert.strictEqual(readyToFetch({ kickoff_at: '2026-10-24T15:00:00Z' }, Date.parse('2026-10-24T22:03:00Z')), true);
});
test('a closed DM is recorded as dms_closed, not retried', () => {
  assert.strictEqual(dmFailureNote({ code: 50007, status: 403 }), 'dms_closed');
  assert.strictEqual(dmFailureNote({ status: 403 }), 'dms_closed');
  assert.strictEqual(dmFailureNote({ status: 500 }), 'error');
});

console.log('live counts');
test('live rows carry only the counts the bar reads, keyed by fixture and player', () => {
  const [r] = liveRows(123, [{ player_id: 7, minutes: 54, shots_total: 2, shots_on: 1, fouls_committed: null, fouls_drawn: 1, yellow: 0, red: 0, goals: null, assists: null, raw: {} }], 'T');
  assert.deepStrictEqual(Object.keys(r).sort(), ['assists','fetched_at','fixture_id','fouls_committed','fouls_drawn','goals','minutes','player_id','red','shots_on','shots_total','yellow']);
  assert.strictEqual(r.fixture_id, '123');
  assert.strictEqual(r.shots_total, 2);
});
test('live counts never reach the settlement: they live in their own table', () => {
  const src = fs.readFileSync(path.join(__dirname, 'settleFollows.js'), 'utf8');
  const live = src.slice(src.indexOf('async function fetchLivePlayers'), src.indexOf('async function sendAlerts'));
  assert.ok(/'player_live_stats'/.test(live));
  assert.ok(!/player_stats_fetch_log|'player_match_stats'/.test(live), 'the live fetch must not write the full-time tables');
});

console.log('one rule');
test('settleFollows.js does not re-implement the settlement rule', () => {
  const src = fs.readFileSync(path.join(__dirname, 'settleFollows.js'), 'utf8');
  assert.ok(/rpc\('settle_follows'\)/.test(src), 'it must call the database rule');
  assert.ok(!/>=\s*f\.line|>\s*f\.line|<\s*f\.line/.test(src), 'no comparison against a follow line in JS');
});
test('the migration keeps absent apart from zero', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations/180_follows.sql'), 'utf8');
  assert.ok(/reported := lg\.has_shots/.test(sql));
  assert.ok(/reported := lg\.has_cards/.test(sql));
  assert.ok(/void_reason := 'not_reported'|v_reason := 'not_reported'/.test(sql));
  assert.ok(/'did_not_play'/.test(sql));
});

console.log(`\n${passed} passed`);
