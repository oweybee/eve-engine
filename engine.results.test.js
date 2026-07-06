'use strict';

// Tests for market-aware settlement (fetchResults.resultFromGoals). These cover
// the secondary-market regression where btts/totals signals were always marked
// a loss because the old code compared them to the 1X2 result.

const assert = require('assert');
const { resultFromGoals, settleSignal } = require('./fetchResults');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (err) { console.error(`  ✗ ${label}\n    ${err.message}`); failed++; }
}

// ---- h2h ----
console.log('\nresultFromGoals — h2h');
test('home win', () => assert.strictEqual(resultFromGoals(2, 0, 'h2h', 'home'), 'win'));
test('home loss when away wins', () => assert.strictEqual(resultFromGoals(2, 3, 'h2h', 'home'), 'loss'));
test('away win', () => assert.strictEqual(resultFromGoals(2, 3, 'h2h', 'away'), 'win'));
test('draw win', () => assert.strictEqual(resultFromGoals(1, 1, 'h2h', 'draw'), 'win'));

// ---- btts (the reported bug: Mexico 2-3 England, both scored) ----
console.log('\nresultFromGoals — btts');
test('btts_yes WIN when both score (2-3)', () => assert.strictEqual(resultFromGoals(2, 3, 'btts', 'btts_yes'), 'win'));
test('btts_yes win when both score (1-1)', () => assert.strictEqual(resultFromGoals(1, 1, 'btts', 'btts_yes'), 'win'));
test('btts_yes loss when one team blanks', () => assert.strictEqual(resultFromGoals(2, 0, 'btts', 'btts_yes'), 'loss'));
test('btts_no WIN when a team blanks (0-3)', () => assert.strictEqual(resultFromGoals(0, 3, 'btts', 'btts_no'), 'win'));
test('btts_no loss when both score', () => assert.strictEqual(resultFromGoals(2, 3, 'btts', 'btts_no'), 'loss'));

// ---- totals ----
console.log('\nresultFromGoals — totals');
test('over 2.5 WIN at 5 goals (2-3)', () => assert.strictEqual(resultFromGoals(2, 3, 'totals', 'over', 2.5), 'win'));
test('over 2.5 loss at 2 goals (2-0)', () => assert.strictEqual(resultFromGoals(2, 0, 'totals', 'over', 2.5), 'loss'));
test('under 2.5 win at 2 goals', () => assert.strictEqual(resultFromGoals(2, 0, 'totals', 'under', 2.5), 'win'));
test('under 2.5 loss at 3 goals (2-1)', () => assert.strictEqual(resultFromGoals(2, 1, 'totals', 'under', 2.5), 'loss'));
test('totals with no line is unsettleable', () => assert.strictEqual(resultFromGoals(2, 1, 'totals', 'over', null), null));

// ---- unsettleable / missing ----
console.log('\nresultFromGoals — edge cases');
test('corners not derivable from goals', () => assert.strictEqual(resultFromGoals(2, 1, 'corners', 'over', 9.5), null));
test('missing goals → null', () => assert.strictEqual(resultFromGoals(null, 1, 'btts', 'btts_yes'), null));

// ---- settleSignal gates on finished status but delegates market logic ----
console.log('\nsettleSignal — status gating');
const ftFix = { fixture: { status: { short: 'FT' } }, goals: { home: 2, away: 3 } };
const liveFix = { fixture: { status: { short: '2H' } }, goals: { home: 2, away: 3 } };
test('FT btts_yes both scored → win', () => assert.strictEqual(settleSignal(ftFix, 'btts', 'btts_yes'), 'win'));
test('in-play fixture stays pending (null)', () => assert.strictEqual(settleSignal(liveFix, 'btts', 'btts_yes'), null));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
