/**
 * engine.injuries.test.js — the injury list parser.
 * Run: node engine.injuries.test.js
 *
 * What these pin, all silent if they break:
 *   A TYPE WE GUESSED AT. Only "Missing Fixture" (out) and "Questionable"
 *   (doubt) are stored; anything else is dropped, never mapped to a word.
 *   ANOTHER FIXTURE'S NEWS. A row filed under a different fixture is not
 *   stored against this one.
 *   A VENDOR ERROR READ AS AN EMPTY LIST. A 200 carrying `errors` is a failed
 *   call, so the fixture keeps its previous list rather than being cleared.
 */
'use strict';
const assert = require('assert');
const { parseInjuries, statusFor, vendorError } = require('./fetchInjuries');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const item = (over = {}, player = {}) => ({
  player: { id: 1001, name: 'A. Buongiorno', type: 'Missing Fixture', reason: 'Knee Injury', ...player },
  team: { id: 492, name: 'Napoli' },
  fixture: { id: 555 },
  ...over,
});

console.log('statusFor');
test('maps the two vendor types and nothing else', () => {
  assert.strictEqual(statusFor('Missing Fixture'), 'out');
  assert.strictEqual(statusFor('questionable'), 'doubt');
  assert.strictEqual(statusFor('Injured'), null);
  assert.strictEqual(statusFor(null), null);
});

console.log('parseInjuries');
test('reads a player, his team, the status and the reason', () => {
  const [r] = parseInjuries({ response: [item()] }, 555);
  assert.deepStrictEqual(r, { fixture_id: 555, player_id: 1001, team_api_id: 492,
    player_name: 'A. Buongiorno', status: 'out', reason: 'Knee Injury' });
});
test('drops a row with no player id, no team or an unknown type', () => {
  const rows = parseInjuries({ response: [
    item({}, { id: null }), item({ team: { id: null } }), item({}, { type: 'Unknown' }),
  ] }, 555);
  assert.strictEqual(rows.length, 0);
});
test('ignores a row filed under another fixture', () => {
  assert.strictEqual(parseInjuries({ response: [item({ fixture: { id: 999 } })] }, 555).length, 0);
});
test('a player listed twice keeps the stronger status', () => {
  const rows = parseInjuries({ response: [
    item({}, { type: 'Questionable' }), item({}, { type: 'Missing Fixture', reason: 'Suspended' }),
  ] }, 555);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'out');
  assert.strictEqual(rows[0].reason, 'Suspended');
});
test('a blank reason is null, not an empty string', () => {
  assert.strictEqual(parseInjuries({ response: [item({}, { reason: '  ' })] }, 555)[0].reason, null);
});
test('an empty or malformed body is no rows', () => {
  assert.deepStrictEqual(parseInjuries({}, 555), []);
  assert.deepStrictEqual(parseInjuries(null, 555), []);
});

console.log('vendorError');
test('reads both shapes of the errors field', () => {
  assert.strictEqual(vendorError({ errors: [] }), null);
  assert.strictEqual(vendorError({ errors: {} }), null);
  assert.ok(vendorError({ errors: { token: 'bad key' } }));
  assert.ok(vendorError({ errors: ['x'] }));
});

console.log(`\n${passed} passed`);
