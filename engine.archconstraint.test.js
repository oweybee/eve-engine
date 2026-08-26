// The ratchet for migration 039's mistake.
//
// `value_signals_model_architecture_check` is an ENUMERATION, and every
// migration that has ever touched it drops the constraint and re-adds the WHOLE
// array. So a new architecture is added by copying the previous list — and
// migration 039 copied 028's list rather than 038's, silently repealing both
// 030 and 038:
//
//     028   8 names                                    (no in-play)
//     030   + SUPERMODEL_HALFTIME                      9
//     038   + INPLAY_DIXON_COLES, SECOND_HALF_SNIPER  11
//     039   + LAMBDA_MC, rebuilt from 028's list       9   <- all three GONE
//     055   + MARKET_ANCHORED                         10   <- inherits the loss
//
// Nothing failed, because a CHECK is only felt by a WRITER. The writers it
// silenced were the in-play stages, and by the time they were switched on the
// reason they produced nothing had been in the schema for a month:
// `value_signals` held ZERO rows with phase='inplay', ever, while the pipeline
// ran green 1,290 times. Migration 108 restored the three names.
//
// This test is what stops it happening a fourth time. It is TEXTUAL, like
// engine.undefinedconst and engine.workflows, for the same reasons: the rule is
// about a name in JS matching a name in SQL, the repo carries no linter, and a
// dependency-free ratchet is one that always runs.
//
// It does NOT check the database — it checks that the repo's own latest
// declaration of the constraint admits every architecture the repo's own code
// writes. A migration is what someone intended and the table is what is true
// (CLAUDE.md), so this catches the intention going wrong; the migration's own
// probe catches the table.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;

/** Every `model_architecture: 'NAME'` the engine writes, outside tests. */
function architecturesWritten() {
  const found = new Map();               // NAME -> first file that writes it
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.includes('.test.')) continue;          // fixtures may name anything
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/model_architecture:\s*'([A-Z0-9_]+)'/g)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(DIR, full));
      }
    }
  };
  walk(DIR);
  return found;
}

/** SQL line comments removed, so a header quoting the revert is not read as code. */
function stripSqlComments(src) {
  return src.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

/**
 * The names admitted by the LAST migration to declare the constraint. Reading
 * the last one is the point: an earlier migration admitting a name proves
 * nothing, because a later rewrite is exactly the failure being guarded.
 *
 * THE FIRST VERSION OF THIS FUNCTION COULD NOT FAIL, and that is worth keeping.
 * It searched the raw file and took a fixed 2,000-character window, so it read
 * the REVERT that migration 108's header quotes in a comment — and the window
 * was wide enough to swallow the real declaration after it, so it collected the
 * union of both lists and every negative test passed. A ratchet that cannot go
 * red is not a ratchet; comments are stripped and the window now ends at the
 * array's own `]`.
 */
function architecturesAdmitted() {
  const files = fs.readdirSync(path.join(DIR, 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .sort();
  let latest = null;
  for (const f of files) {
    const src = stripSqlComments(fs.readFileSync(path.join(DIR, 'migrations', f), 'utf8'));
    const i = src.search(/add\s+constraint\s+value_signals_model_architecture_check/i);
    if (i === -1) continue;
    const rest = src.slice(i);
    const close = rest.indexOf(']');
    if (close === -1) continue;
    const names = new Set([...rest.slice(0, close).matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]));
    if (names.size) latest = { file: f, names };
  }
  return latest;
}

const written = architecturesWritten();
const admitted = architecturesAdmitted();

let failures = 0;

if (!admitted) {
  console.error('FAIL: no migration declares value_signals_model_architecture_check');
  process.exit(1);
}

for (const [name, file] of written) {
  if (admitted.names.has(name)) continue;
  failures++;
  console.error(
    `FAIL ${file} writes model_architecture '${name}', which ` +
    `migrations/${admitted.file} does not admit — Postgres will reject every ` +
    `such row, and insertModelSignals' catch will log it and let the job exit 0. ` +
    `This is migration 039's mistake.`
  );
}

// The other direction is NOT an error: the list deliberately keeps retired
// names so historic rows and any future restore still validate (migration 055's
// ruling on MARKET_CONSENSUS). Only a WRITER with no seat is a failure.

// And the one exclusion that is load-bearing rather than incidental.
if (admitted.names.has('ELO')) {
  failures++;
  console.error(
    `FAIL migrations/${admitted.file} admits 'ELO'. Migration 088 gave ELO a ` +
    `measured sigma BECAUSE this constraint keeps it from writing — letting it ` +
    `write is the product starting to back ELO selections, which is an owner ` +
    `ruling and not a schema edit.`
  );
}

if (failures) {
  console.error(`\narchitecture constraint: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `architecture constraint: ${written.size} written, all admitted by ` +
  `migrations/${admitted.file}; ELO still excluded`
);
