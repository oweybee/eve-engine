// The check that would have caught the ten-hour outage of 22 Aug 2026.
//
// `${{ cancelled() }}` was written inside a `run:` block in engine.yml. The
// status-check functions — success(), failure(), cancelled(), always() — are
// legal ONLY as the value of an `if:` condition. Anywhere else GitHub's
// expression parser rejects the ENTIRE FILE, and the failure mode is the worst
// one there is: an unparseable workflow does not fire its `schedule:`, and
// there is no failed run, no annotation and no notification to say so. The
// engine stopped dead from 21:01 to 07:30 while every other workflow in the
// repo ran normally, and the only symptom was the odds board going stale.
//
// Neither of the checks that ran at the time could see it. `npm test` does not
// read YAML, and a YAML parse succeeds — the grammar that fails is GitHub's
// expression evaluator, one layer above. The only remote check is the dispatch
// API refusing to queue the run.
//
// So this is the local one. It is deliberately textual rather than a YAML
// walk: the rule is about where an expression may appear, the repo carries no
// YAML parser, and a dependency-free ratchet is one that always runs.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '.github', 'workflows');
const STATUS_FN = /\$\{\{[^}]*\b(success|failure|cancelled|always)\s*\(\s*\)/;
// The one legal home: `if:` as a mapping key, with or without a `- ` before it
// (a step's first key) — plus `if: >`/`|` block scalars on the following lines.
const IF_KEY = /^\s*(-\s+)?if:\s/;

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL ' + msg); };

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) fail('no workflow files found under .github/workflows');

for (const file of files) {
  const full = path.join(DIR, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');

  let inIfBlock = false;
  let ifBlockIndent = 0;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const indent = line.length - line.trimStart().length;

    // Track a block-scalar `if: >` / `if: |` so its continuation lines stay legal.
    if (IF_KEY.test(line)) {
      inIfBlock = /^\s*(-\s+)?if:\s*[>|]/.test(line);
      ifBlockIndent = indent;
    } else if (inIfBlock && (line.trim() === '' || indent > ifBlockIndent)) {
      // still inside the block scalar
    } else {
      inIfBlock = false;
    }

    if (!STATUS_FN.test(line)) return;
    if (IF_KEY.test(line) || inIfBlock) return;

    fail(
      `${file}:${lineNo} uses a status-check function outside an \`if:\` — ` +
      `this makes the whole workflow unparseable and silently stops its cron. ` +
      `Read \${{ job.status }} instead.\n       ${line.trim()}`
    );
  });

  // A comment is not a violation, but a workflow that mentions the trap without
  // the fix beside it is worth nothing; no assertion here, only the scan above.
}

// A positive control: the rule must actually fire on the shape it exists for,
// or a regex that matches nothing would pass this file silently for ever.
const probe = '          if   [ "${{ cancelled() }}" = "true" ]; then STATE=x';
if (!STATUS_FN.test(probe)) fail('the detector does not match the shape it was written for');
if (IF_KEY.test(probe)) fail('the `if:` allowance wrongly admits a bash `if [ ... ]`');

// And the legal shape must NOT trip it.
for (const ok of ['        if: always()', '      - if: ${{ failure() }}', "    if: success() && github.ref == 'refs/heads/main'"]) {
  if (!IF_KEY.test(ok)) fail(`the \`if:\` allowance rejects a legal condition: ${ok}`);
}

console.log(`workflow lint: ${files.length} file(s) scanned, ${failures} violation(s)`);
if (failures) process.exit(1);
