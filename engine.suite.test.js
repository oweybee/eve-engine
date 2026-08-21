/**
 * engine.suite.test.js — the suite covers itself.
 *
 * `npm test` is a hand-maintained `&&` chain of 30 filenames. Two test files
 * written in this repo (engine.capturesnapshot, engine.eloforecasts) were never
 * added to it, so CI had never run them: they passed on disk and guarded
 * nothing. A chain nobody checks is a list that drifts, and the drift is
 * invisible — the suite goes green either way.
 *
 * This asserts every engine.*.test.js on disk is named in the script, and that
 * every name in the script exists. Run: node engine.suite.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = pkg.scripts.test;

const named = new Set(script.match(/engine\.[A-Za-z0-9.]*test\.js/g) ?? []);
const onDisk = fs.readdirSync(root).filter(f => /^engine\..*\.test\.js$/.test(f));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); process.exitCode = 1; }
}

test('every test file on disk is run by npm test', () => {
  const unrun = onDisk.filter(f => !named.has(f));
  assert.deepStrictEqual(unrun, [],
    `not in the npm test chain, so CI never runs them: ${unrun.join(', ')}`);
});

test('every file named in npm test exists', () => {
  const absent = [...named].filter(f => !fs.existsSync(path.join(root, f)));
  assert.deepStrictEqual(absent, [],
    `named in the npm test chain but not on disk: ${absent.join(', ')}`);
});

test('this file is in the chain — otherwise it guards nothing', () => {
  assert.ok(named.has('engine.suite.test.js'),
    'engine.suite.test.js must itself be named in package.json scripts.test');
});

/**
 * AND A TEST AFTER `process.exit` IS THE SAME BUG ONE LEVEL IN.
 *
 * Most files here end `console.log(summary); process.exit(failed ? 1 : 0);`.
 * Three census cases were appended to engine.marketprob.test.js BELOW that exit
 * and therefore never ran — for long enough that two of them used an assert API
 * the file does not have and nobody found out. The suite was green, the chain
 * was complete, and the cases guarded nothing. That is exactly the failure the
 * file above exists to catch, one scope smaller.
 */
test('no test is declared after the file exits', () => {
  const offenders = [];
  for (const f of onDisk) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    const exitAt = src.reduce((last, line, i) => /process\.exit\(/.test(line) ? i : last, -1);
    if (exitAt < 0) continue;
    const after = src.slice(exitAt + 1).filter(l => /^\s*(test|describe)\(/.test(l)).length;
    if (after) offenders.push(`${f} (${after} after line ${exitAt + 1})`);
  }
  assert.deepStrictEqual(offenders, [],
    `declared below process.exit(), so they never run: ${offenders.join(', ')}`);
});

console.log(`\nsuite coverage: ${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
