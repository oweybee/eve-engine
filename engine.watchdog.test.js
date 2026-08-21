'use strict';

/**
 * engine.watchdog.test.js — a killed step must SAY it was killed.
 *
 * Three times this engine has had a step die at a timeout and report nothing:
 * fetchTeamStats (silent for two weeks), captureIndependentLines (starved by a
 * shared job timeout), and the engine job itself (six runs cancelled between
 * 610s and 633s). Every one read as a quiet slate.
 *
 * These cases actually SPAWN a process, signal it, and read what it printed —
 * a handler asserted only by unit-calling it would prove nothing about whether
 * Node still runs it once the signal arrives.
 *
 * Run: node engine.watchdog.test.js
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { beginWatchdog, SIGTERM_EXIT } = require('./lib/watchdog');

let passed = 0, failed = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${label}`); passed++; })
    .catch(e => { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; });
}

/** Spawn a child that arms the watchdog and then hangs, signal it, collect
 *  everything it wrote. `--stage` names the phase so the report can quote it. */
function killAfterArming({ signal = 'SIGTERM', reporter = false } = {}) {
  const src = `
    const { beginWatchdog } = require(${JSON.stringify(path.join(__dirname, 'lib', 'watchdog'))});
    const dog = beginWatchdog('probeScript'${reporter
      ? ", { onTerminate: ({ stage }) => console.error('[probe] partial at ' + stage) }"
      : ''});
    dog.stage('the middle of the work');
    process.send ? process.send('armed') : console.log('armed');
    setInterval(() => {}, 1000);
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => {
      out += d;
      // Signal only once the handler is definitely registered — signalling a
      // process that has not finished booting proves nothing about the handler.
      if (out.includes('armed')) child.kill(signal);
    });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code, sig) => resolve({ code, sig, out, err }));
  });
}

console.log('lib/watchdog — a killed step says so');

(async () => {
  await test('SIGTERM prints an explicit, greppable line naming the stage', async () => {
    const r = await killAfterArming({ signal: 'SIGTERM' });
    assert.match(r.err, /TERMINATED by SIGTERM/, 'names the signal');
    assert.match(r.err, /probeScript/, 'names the script');
    assert.match(r.err, /the middle of the work/, 'names the stage it died in');
    assert.match(r.err, /PARTIAL or ABSENT/, 'says what it means for the data');
  });

  await test('and a GitHub annotation beside it, so the run list shows it', async () => {
    const r = await killAfterArming({ signal: 'SIGTERM' });
    assert.match(r.err, /^::error title=probeScript killed::/m,
      'the ::error:: annotation is what surfaces on the run summary');
    // BOTH forms, deliberately: the annotation does not survive `tee` or a
    // local run, and the plain line does not surface in the run list.
    assert.match(r.err, /^\[watchdog\] /m);
  });

  await test('exits 143, so a kill is distinguishable from an ordinary failure', async () => {
    const r = await killAfterArming({ signal: 'SIGTERM' });
    assert.strictEqual(r.code, SIGTERM_EXIT);
    assert.strictEqual(r.sig, null, 'exited under its own power, not re-raised');
  });

  await test('SIGINT is caught too — a cancelled workflow sends it first', async () => {
    const r = await killAfterArming({ signal: 'SIGINT' });
    assert.match(r.err, /TERMINATED by SIGINT/);
    assert.strictEqual(r.code, SIGTERM_EXIT);
  });

  await test('the reporter runs, so a partial count reaches the log', async () => {
    const r = await killAfterArming({ signal: 'SIGTERM', reporter: true });
    assert.match(r.err, /\[probe\] partial at the middle of the work/);
  });

  await test('a throwing reporter cannot swallow the message above it', () => {
    // The whole point of the handler is that SOMETHING is printed, so a
    // reporter that blows up must not take the alert with it.
    const lines = [];
    const realErr = console.error;
    const realExit = process.exit;
    console.error = (...a) => lines.push(a.join(' '));
    process.exit = () => {};
    try {
      const dog = beginWatchdog('throwy', { onTerminate: () => { throw new Error('boom'); } });
      dog.stage('s');
      process.emit('SIGTERM');
      dog.finish();
    } finally {
      console.error = realErr;
      process.exit = realExit;
    }
    assert.ok(lines.some(l => /TERMINATED by SIGTERM/.test(l)), 'the alert still printed');
    assert.ok(lines.some(l => /reporter failed: boom/.test(l)), 'and the reporter failure is named');
  });

  await test('finish() disarms — a signal during shutdown says nothing', () => {
    const lines = [];
    const realErr = console.error;
    const realExit = process.exit;
    console.error = (...a) => lines.push(a.join(' '));
    process.exit = () => {};
    try {
      const dog = beginWatchdog('quiet');
      dog.finish();
      process.emit('SIGTERM');
    } finally {
      console.error = realErr;
      process.exit = realExit;
    }
    assert.deepStrictEqual(lines, [], 'a finished script that is then signalled is not a kill');
  });

  await test('reports once, however many signals arrive', () => {
    const lines = [];
    const realErr = console.error;
    const realExit = process.exit;
    console.error = (...a) => lines.push(a.join(' '));
    process.exit = () => {};
    try {
      const dog = beginWatchdog('once');
      process.emit('SIGTERM');
      process.emit('SIGTERM');
      process.emit('SIGINT');
      dog.finish();
    } finally {
      console.error = realErr;
      process.exit = realExit;
    }
    // COUNT THE ANNOTATIONS, NOT THE MATCHES. One alert is deliberately TWO
    // lines — the `::error::` for the run summary and the plain one for a log
    // grep — so a naive /TERMINATED by/ count reads a single correct alert as
    // two and this assertion failed on its first run for that reason.
    const alerts = lines.filter(l => l.startsWith('::error title='));
    assert.strictEqual(alerts.length, 1, 'one kill, one alert');
    assert.strictEqual(lines.filter(l => l.startsWith('[watchdog] ')).length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
