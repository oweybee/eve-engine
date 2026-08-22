// The ratchet for `[details] fatal: LINEUP_WINDOW_MINUTES is not defined`.
//
// 21c205c moved the lineup window into lib/lineupCapture's DEFAULTS and deleted
// the `const LINEUP_WINDOW_MINUTES` that fetchMatchDetails.js declared — but
// left ONE surviving reference, inside a template literal in a console.log.
// So the file parsed, `node --check` passed, `npm test` passed, and the step
// died with a ReferenceError one second into every tick from 11:54 UTC on
// 22 Aug. match_predictions stopped at 12:06 and nothing said so: the job still
// reported success (continue-on-error), and the only trace was one line in a
// run log nobody reads.
//
// It is textual on purpose, like engine.workflows.test.js: the rule is about
// an identifier being READ without being BOUND, the repo carries no linter, and
// a dependency-free ratchet is one that always runs.
//
// Scope is deliberately narrow — SCREAMING_SNAKE names only, which in this
// codebase are module constants and nothing else. A name must contain an
// underscore, so JSON/Math/URL and every class name are out of scope, and so is
// any `.PROPERTY` access or `{ KEY: ... }` object key.
'use strict';

const fs = require('fs');
const path = require('path');

/** Bindings that exist without being declared in the file. */
const AMBIENT = new Set(['NODE_ENV']);

const NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** Remove comments and string/template bodies so only CODE is scanned. */
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    if (c === '`') {
      // Keep `${ ... }` bodies — that is exactly where the bug hid — drop the rest.
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2; let depth = 1; let inner = '';
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) inner += src[i];
            i++;
          }
          out += inner;
          // The body may itself hold string literals — 'MARKET_CONSENSUS' in a
          // template expression is DATA, not a read. Strip it the same way.
          out = out.slice(0, out.length - inner.length) + strip(inner) + ';';
          continue;
        }
        i++;
      }
      i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Every SCREAMING_SNAKE name this file BINDS: declaration, destructure, param, rename. */
function bound(code) {
  const set = new Set();
  const add = (s) => { for (const m of s.matchAll(NAME)) set.add(m[0]); };

  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g)) add(m[1]);
  // `const REF_TILT_MIN = 0.80, REF_TILT_MAX = 1.25;` — every declarator binds,
  // not just the first one after the keyword.
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s+|,\s*)([A-Za-z0-9_$]+)\s*=/g)) add(m[1]);
  // Destructuring and object literals: `{ A, B: C }` — C binds on the left of `=`.
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const bindsAs = part.includes(':') ? part.split(':').pop() : part;
      add(bindsAs);
    }
  }
  for (const m of code.matchAll(/(?:function\s*[A-Za-z0-9_$]*|=>)?\s*\(([^)]*)\)\s*(?:=>|\{)/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(([^)]*)\)/g)) add(m[1]);
  return set;
}

/** Every SCREAMING_SNAKE name this file READS, ignoring `.PROP` and `{ KEY:` object keys. */
function read(code) {
  const hits = new Set();
  for (const m of code.matchAll(NAME)) {
    const before = code.slice(Math.max(0, m.index - 2), m.index);
    if (before.endsWith('.')) continue;                       // property access
    const after = code.slice(m.index + m[0].length).match(/^\s*:/);
    if (after) continue;                                      // object key / label
    hits.add(m[0]);
  }
  return hits;
}

const DIR = __dirname;
const FILES = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .concat(fs.readdirSync(path.join(DIR, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f))
  .sort();

let failures = 0;
let scanned = 0;

for (const rel of FILES) {
  const code = strip(fs.readFileSync(path.join(DIR, rel), 'utf8'));
  const declared = bound(code);
  scanned++;
  for (const name of read(code)) {
    if (declared.has(name) || AMBIENT.has(name)) continue;
    failures++;
    console.error(
      `FAIL ${rel}: reads ${name} but never binds it — this is the ` +
      `LINEUP_WINDOW_MINUTES shape: it parses, and it throws at runtime.`
    );
  }
}

if (failures) {
  console.error(`\nundefined constants: ${failures} failure(s) across ${scanned} file(s)`);
  process.exit(1);
}
console.log(`undefined constants: ${scanned} file(s) scanned, 0 violation(s)`);
