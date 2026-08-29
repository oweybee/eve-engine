'use strict';

/**
 * engine.apiquota.test.js — the API-Football usage tracker.
 *
 * Twelve scripts call the vendor and none of them read a response header, so
 * the daily allowance has never been measured and `DAILY_REQUEST_BUDGET` is a
 * configured intention rather than a reading. These pin the three properties
 * that make the tracker worth having: it must not cost a request, it must never
 * break an ingest, and "not measured" must stay distinguishable from
 * "measured as zero".
 *
 * Run: node engine.apiquota.test.js   (zero deps, no DB/network)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const q = require('./lib/apiFootballQuota');

let passed = 0, failed = 0;
function test(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}
async function testAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.error(`  ✗ ${label}\n    ${e.message}`); failed++; }
}

const HEADERS = {
  'x-ratelimit-requests-limit': '75000',
  'x-ratelimit-requests-remaining': '62310',
  'x-ratelimit-limit': '450',
  'x-ratelimit-remaining': '443',
};
const NOW = new Date('2026-08-27T10:00:00Z');

console.log('reading the headers');
test('the four documented headers are parsed', () => {
  assert.deepStrictEqual(q.quotaFromHeaders(HEADERS), {
    limitDay: 75000, remainingDay: 62310, limitMinute: 450, remainingMinute: 443,
  });
});
test('header lookup is case-insensitive — Node lowercases, other clients may not', () => {
  assert.strictEqual(
    q.quotaFromHeaders({ 'X-RateLimit-Requests-Remaining': '10' }).remainingDay, 10);
});
test('an unrecognised response yields nulls, never zeros', () => {
  // The names are from the v3 docs and unverified against a live feed. If they
  // are wrong the tracker must record NOTHING — a stored zero would read as an
  // exhausted quota and send someone hunting a rate limit that is not there.
  const empty = q.quotaFromHeaders({ 'content-type': 'application/json' });
  assert.deepStrictEqual(empty,
    { limitDay: null, remainingDay: null, limitMinute: null, remainingMinute: null });
  assert.strictEqual(q.isEmpty(empty), true);
  assert.strictEqual(q.isEmpty(q.quotaFromHeaders(HEADERS)), false);
});
test('a non-numeric header is null, not NaN', () => {
  assert.strictEqual(q.quotaFromHeaders({ 'x-ratelimit-requests-limit': 'lots' }).limitDay, null);
});

console.log('folding a reading into what is stored');
test('spent_today is DERIVED, never accumulated', () => {
  // A total we add up drifts the moment a run dies mid-flight, and the server
  // is already keeping this one.
  const m = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  assert.strictEqual(m.spent_today, 12690);
  assert.strictEqual(m.fraction_left, 0.8308);
  assert.strictEqual(m.day, '2026-08-27');
});
test('a partial reading keeps what it does not carry', () => {
  const first = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  const second = q.mergeQuota(first, { limitDay: null, remainingDay: 61000,
                                       limitMinute: null, remainingMinute: null }, NOW);
  assert.strictEqual(second.limitDay, 75000, 'the day allowance survives');
  assert.strictEqual(second.remainingDay, 61000);
  assert.strictEqual(second.spent_today, 14000);
});
test('a day rollover is visible rather than looking like a refund', () => {
  const yesterday = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  const today = q.mergeQuota(yesterday, q.quotaFromHeaders(HEADERS),
                             new Date('2026-08-28T00:05:00Z'));
  assert.strictEqual(today.day, '2026-08-28');
  assert.ok(today.rolled_over_at, 'the rollover is stamped');
});
test('an unmeasurable day reports null, not zero spend', () => {
  const m = q.mergeQuota(null, { limitDay: null, remainingDay: null,
                                 limitMinute: 450, remainingMinute: 443 }, NOW);
  assert.strictEqual(m.spent_today, null);
  assert.strictEqual(m.fraction_left, null);
});

console.log('deciding whether to write');
test('a moved counter always writes', () => {
  const stored = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  const next = q.mergeQuota(stored, { ...q.quotaFromHeaders(HEADERS), remainingDay: 62000 }, NOW);
  assert.strictEqual(q.shouldPersist(stored, next, NOW), true);
});
test('an unchanged, recent counter does NOT rewrite the row', () => {
  const stored = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  const next = q.mergeQuota(stored, q.quotaFromHeaders(HEADERS),
                            new Date(NOW.getTime() + 5_000));
  assert.strictEqual(q.shouldPersist(stored, next, new Date(NOW.getTime() + 5_000)), false,
    'a 60-second loop with two reporting scripts must not write twice a minute');
});
test('an unchanged but STALE counter writes, so the row proves it is live', () => {
  const stored = q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW);
  const later = new Date(NOW.getTime() + 120_000);
  assert.strictEqual(q.shouldPersist(stored, q.mergeQuota(stored, q.quotaFromHeaders(HEADERS), later), later), true);
});
test('nothing stored yet always writes', () => {
  assert.strictEqual(q.shouldPersist(null, q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW), NOW), true);
});

console.log('the low-quota warning');
test('it fires on the fraction left, not on a typed count', () => {
  const low = q.mergeQuota(null, { limitDay: 75000, remainingDay: 3000,
                                   limitMinute: null, remainingMinute: null }, NOW);
  assert.strictEqual(q.isLow(low), true);
  assert.strictEqual(q.isLow(q.mergeQuota(null, q.quotaFromHeaders(HEADERS), NOW)), false);
});
test('an unmeasured quota is never reported as low', () => {
  // "we did not read it" and "it is nearly gone" are different facts.
  assert.strictEqual(q.isLow(q.mergeQuota(null, { limitDay: null, remainingDay: null,
    limitMinute: null, remainingMinute: null }, NOW)), false);
  assert.strictEqual(q.isLow(null), false);
});

console.log('report() must never break an ingest');
test('a malformed headers object is swallowed', () => {
  q.resetForTests();
  q.report(null); q.report(undefined); q.report('nonsense'); q.report(42);
  assert.strictEqual(q.latestReading(), null, 'and records nothing');
});
test('the FRESHEST reading wins — this is a counter, not a tally', () => {
  q.resetForTests();
  q.report(HEADERS);
  q.report({ ...HEADERS, 'x-ratelimit-requests-remaining': '61000' });
  assert.strictEqual(q.latestReading().remainingDay, 61000);
});
test('an empty response does not clobber a good reading', () => {
  q.resetForTests();
  q.report(HEADERS);
  q.report({ 'content-type': 'application/json' });
  assert.strictEqual(q.latestReading().remainingDay, 62310);
});

async function persistTests() {
console.log('persisting');
await testAsync('a run with no reading writes nothing and says so', async () => {
  q.resetForTests();
  const r = await q.persistQuota({ from() { assert.fail('must not touch the database'); } }, NOW);
  assert.deepStrictEqual({ written: r.written, quota: r.quota }, { written: false, quota: null });
});
await testAsync('a write failure is reported, never thrown', async () => {
  // A quota row that fails to write must not fail an ingest that succeeded.
  q.resetForTests(); q.report(HEADERS);
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: { message: 'boom' } }),
    }),
  };
  const r = await q.persistQuota(client, NOW);
  assert.strictEqual(r.written, false);
  assert.strictEqual(r.reason, 'boom');
});
await testAsync('a read failure still writes — a lost history is not a lost reading', async () => {
  q.resetForTests(); q.report(HEADERS);
  let wrote = null;
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'nope' } }) }) }),
      upsert: async (row) => { wrote = row; return { error: null }; },
    }),
  };
  const r = await q.persistQuota(client, NOW);
  assert.strictEqual(r.written, true);
  assert.strictEqual(wrote.key, 'api_football_quota');
  assert.strictEqual(JSON.parse(wrote.value).remainingDay, 62310);
});

}

console.log('the call sites — a tracker nothing reports to is a dead tracker');
const REPORTERS = ['ingestLiveOdds.js', 'fetchLiveStats.js', 'ingestOdds.js',
                   'fetchMatchDetails.js', 'fetchLineups.js', 'fetchTeamStats.js'];
test('every wired script reports its headers AND persists', () => {
  // Source assertions, because a reporter that stops reporting looks exactly
  // like a vendor that stopped sending the header. This repo has already
  // shipped a census that was dead because the call site never passed it.
  for (const f of REPORTERS) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(/require\('\.\/lib\/apiFootballQuota'\)/.test(src), `${f}: must require the tracker`);
    assert.ok(/apiQuota\.report\(res\.headers\)/.test(src), `${f}: must report its headers`);
    assert.ok(/apiQuota\.persistQuota\(getClient\(\)\)/.test(src), `${f}: must persist at the end of a run`);
  }
});
test('NOTHING calls /status — measuring must not cost a request', () => {
  for (const f of [...REPORTERS, 'lib/apiFootballQuota.js', 'scripts/apiQuota.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(!/httpGet\(\s*['"`]\/status/.test(src),
      `${f}: /status spends one against the counter it reports`);
  }
});
test('the CLI reads the stored row and issues no vendor call', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scripts/apiQuota.js'), 'utf8');
  assert.ok(/readQuota/.test(src));
  assert.ok(!/api-sports\.io/.test(src), 'it must not talk to the vendor at all');
});

persistTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
