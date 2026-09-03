// The ratchet for migration 121: a stripped score is explained, and so is one
// that never arrived.
//
// `score_needs_measured_sigma()` used to open with
//
//     if new.mxs is null and new.mxs_band is null then
//       return new;
//     end if;
//
// so it explained a score it STRIPPED and said nothing about a score the
// writer never attempted. The engine's own scorer fails closed — `scoreSignal`
// returns nulls for every field for an architecture with no measured sigma —
// so those rows insert with `mxs` already null, take that early return, and
// land with no score AND no `score_withheld_reason`. Two guards, each correct,
// and the audit trail falls down the gap between them. Measured on production,
// 3 Sep 2026: 472 rows, 390 of them from the two in-play writers migration 108
// had just made storable, 52 in September alone against zero explained ones.
//
// THE FIX IS NOT A CHECK CONSTRAINT, and this test exists partly to record
// that. `check (mxs is not null or score_withheld_reason is not null)` would
// reject every in-play insert, turning a silent audit gap into an ingestion
// outage and repealing the rule the guard was built on: it NULLS rather than
// RAISES, because a miscalibrated model must not stop the product.
//
// It is TEXTUAL, like engine.archconstraint and engine.undefinedconst, for the
// same reasons: the rule is about what the repo's own latest SQL declares, the
// repo carries no linter, and a dependency-free ratchet is one that always
// runs. The migration's own probes catch the TABLE; this catches the intention.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'migrations');
const FN = 'score_needs_measured_sigma';

/**
 * SQL line comments removed FIRST, and that is load-bearing rather than tidy:
 * migration 121's own header quotes the broken early return verbatim, so a
 * scanner reading the raw file finds `return new;` directly under the null
 * test and concludes the bug is still there. engine.archconstraint records the
 * same trap from the other side, where a quoted revert made every negative
 * test pass.
 */
function stripSqlComments(src) {
  return src.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

/** The body of the LAST migration to declare the function. */
function latestBody() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  let latest = null;
  for (const f of files) {
    const src = stripSqlComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const i = src.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}\\s*\\(`, 'i'));
    if (i === -1) continue;
    const rest = src.slice(i);
    const close = rest.search(/end\s+\$function\$/i);
    if (close === -1) continue;
    latest = { file: f, body: rest.slice(0, close) };
  }
  return latest;
}

/**
 * The arriving-null branch: from the test for "no claim on this row" to the
 * `return new` that closes it. Returned separately from the strip path so a
 * reason set only on the strip path cannot satisfy the assertions below.
 */
function arrivingNullBranch(body) {
  const i = body.search(/if\s+new\.mxs\s+is\s+null\s+and\s+new\.mxs_band\s+is\s+null\s+then/i);
  if (i === -1) return null;
  const rest = body.slice(i);
  const end = rest.search(/return\s+new\s*;/i);
  if (end === -1) return null;
  return rest.slice(0, end);
}

const latest = latestBody();

// ── The scanner guards itself. An analysis that found nothing would satisfy
//    every "does not contain" assertion while proving nothing at all.
assert.ok(latest, `no migration declares public.${FN}()`);
assert.ok(latest.body.length > 400,
  `the ${FN} body read from ${latest.file} is too short to be the real one`);
assert.ok(/score_withheld_reason/.test(latest.body),
  `${latest.file} declares ${FN} without ever mentioning score_withheld_reason`);

const branch = arrivingNullBranch(latest.body);
assert.ok(branch, `${latest.file}: ${FN} has no arriving-null branch to check`);

// ── 1. An arriving null is explained ───────────────────────────────────────
assert.ok(/score_withheld_reason\s*:=/.test(branch),
  `${latest.file}: the arriving-null branch of ${FN} returns without setting a reason — ` +
  'a row the writer never scored would land unexplained again (migration 121)');

// ── 2. A reason the CALLER supplied is preserved ────────────────────────────
// Not defensive. 060's overround guard is `trg_score_needs_coherent_market_prob`
// and same-timing triggers fire in ALPHABETICAL order, so it runs BEFORE this
// one: when it strips a claim it sets its own, more specific sentence and then
// hands this guard a null score with a reason attached. Filling
// unconditionally would overwrite the better sentence with a vaguer one — and
// would also clobber a backfill's own account of why it removed a score.
assert.ok(/if\s+new\.score_withheld_reason\s+is\s+null\s+then/i.test(branch),
  `${latest.file}: the arriving-null branch of ${FN} sets a reason unconditionally — ` +
  "060's reason and any backfill's own reason would be overwritten (migration 121)");

// ── 3. The wording 086 buckets on survives ─────────────────────────────────
// `model_detail()` groups the withheld census with
// `like '%no row in model_calibration%'`. A paraphrase here would look correct
// on the row and fall into 'other' in the census.
assert.ok(/no row in model_calibration/.test(branch),
  `${latest.file}: the uncalibrated reason no longer contains the substring ` +
  "migration 086's census buckets on ('no row in model_calibration')");

// ── 4. Nobody turned this into an ingestion outage ─────────────────────────
// The rejected fix, encoded so it cannot arrive quietly in a later migration.
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.sql'))) {
  const src = stripSqlComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
  assert.ok(
    !/check\s*\(\s*mxs\s+is\s+not\s+null\s+or\s+score_withheld_reason\s+is\s+not\s+null/i.test(src),
    `${f}: a CHECK requiring a reason would reject every in-play insert — ` +
    'the guard NULLS rather than RAISES on purpose (migration 121)');
}

// ── 5. NEGATIVE CHECK: the assertions above must go red on the old body ────
// A ratchet nobody has watched fail is a ratchet nobody knows the shape of.
// This is the pre-121 branch, verbatim.
const OLD_BRANCH = `
  if new.mxs is null and new.mxs_band is null then
    `;
assert.ok(!/score_withheld_reason\s*:=/.test(OLD_BRANCH),
  'the negative fixture already sets a reason, so assertion 1 could not fail');
assert.ok(!/if\s+new\.score_withheld_reason\s+is\s+null\s+then/i.test(OLD_BRANCH),
  'the negative fixture already guards the reason, so assertion 2 could not fail');

console.log(`engine.scorereason: ${FN} explains an arriving null (${latest.file}); ` +
  "a caller's reason survives; 086's bucket substring intact; no reason-CHECK anywhere.");
