/**
 * engine.teamalias.test.js — the write path, against a stub client.
 * Run: node engine.teamalias.test.js
 *
 * lib/teamNames decides WHICH names are one club, and engine.teamnames.test.js
 * audits that against real production names. This file covers the other half:
 * getting the answer into the table without losing a human's decision, without
 * over-reporting, and on the conflict target the migration actually declares.
 *
 * The stub records every call, so the assertions are about what the job asks
 * the database to do — which is the part no amount of reading the code proves.
 */
'use strict';
const assert = require('assert');
const { planAliasWrites, writeAliases, manualKey } = require('./buildTeamAliases');

let passed = 0;
function test(n, f) {
  try { f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}
async function atest(n, f) {
  try { await f(); passed++; console.log(`  ✓ ${n}`); }
  catch (e) { console.error(`  ✗ ${n}: ${e.message}`); process.exitCode = 1; }
}

const alias = (source, name, key, method = 'exact') =>
  ({ source, name, canonical_key: key, method });

/**
 * A supabase-js stand-in that records upserts. `returns` decides what the
 * database claims to have written, so a partial write can be simulated.
 */
function stubClient({ error = null, returns = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert(rows, opts) {
          calls.push({ table, rows, opts });
          const data = returns ? returns(rows) : rows.map(r => ({ source: r.source }));
          return { select: () => ({ data: error ? null : data, error }) };
        },
      };
    },
  };
}

// ── what gets written ───────────────────────────────────────────────────────

test('every row carries exactly the columns team_alias has', () => {
  const [row] = planAliasWrites([alias('live_feed', 'Leeds', 'leedsunited', 'prefix')],
                                new Set(), '2026-08-05T00:00:00.000Z');
  assert.deepStrictEqual(Object.keys(row).sort(),
    ['canonical_key', 'method', 'raw_name', 'source', 'updated_at']);
  assert.strictEqual(row.raw_name, 'Leeds');       // the RAW name, not the key
  assert.strictEqual(row.canonical_key, 'leedsunited');
  assert.strictEqual(row.method, 'prefix');
  assert.strictEqual(row.updated_at, '2026-08-05T00:00:00.000Z');
});

test('the job never writes method=manual — that word is reserved for humans', () => {
  // The matcher has no business claiming a human decided something. If it did,
  // the next run would treat its own output as untouchable and freeze a mistake
  // in place permanently.
  const [row] = planAliasWrites([alias('live_feed', 'X', 'x', 'manual')], new Set(), 'T');
  assert.strictEqual(row.method, 'exact');
});

test('incomplete aliases are dropped rather than written as nulls', () => {
  const rows = planAliasWrites([
    alias('live_feed', 'Leeds', 'leedsunited'),
    { source: 'live_feed', name: 'Nokey', canonical_key: '' },
    { source: '', name: 'Nosource', canonical_key: 'k' },
    { source: 'live_feed', name: '', canonical_key: 'k' },
    null,
  ], new Set(), 'T');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].raw_name, 'Leeds');
});

// ── the human's decisions survive ───────────────────────────────────────────

test('a manual row is never overwritten', () => {
  const shield = new Set([manualKey('football_data', 'Oxford')]);
  const rows = planAliasWrites([
    alias('football_data', 'Oxford', 'oxfordunited'),
    alias('football_data', 'Reading', 'reading'),
  ], shield, 'T');
  assert.deepStrictEqual(rows.map(r => r.raw_name), ['Reading']);
});

test('the shield matches the way the database matches — case and space insensitive', () => {
  // mx_canonical_team() looks up on lower(trim(raw_name)). If the shield were
  // stricter than that, a human who typed "Man City" would be silently
  // overwritten by the job's "man city", which is the whole failure mode.
  assert.strictEqual(manualKey('live_feed', '  Man City  '), manualKey('live_feed', 'man city'));
  const shield = new Set([manualKey('live_feed', 'MAN CITY')]);
  const rows = planAliasWrites([alias('live_feed', ' Man City ', 'manchestercity')], shield, 'T');
  assert.strictEqual(rows.length, 0);
});

test('a shield for a different source does not protect this one', () => {
  const shield = new Set([manualKey('football_data', 'Oxford')]);
  const rows = planAliasWrites([alias('live_feed', 'Oxford', 'oxfordunited')], shield, 'T');
  assert.strictEqual(rows.length, 1);
});

test('no aliases and no shield is a clean no-op, not a crash', () => {
  assert.deepStrictEqual(planAliasWrites(null, null, 'T'), []);
  assert.deepStrictEqual(planAliasWrites([], undefined, 'T'), []);
});

// ── the upsert itself ───────────────────────────────────────────────────────

atest('it upserts on the primary key declared in migration 053', async () => {
  const db = stubClient();
  await writeAliases(db, planAliasWrites([alias('live_feed', 'Leeds', 'leedsunited')], new Set(), 'T'));
  assert.strictEqual(db.calls.length, 1);
  assert.strictEqual(db.calls[0].table, 'team_alias');
  // Must match `primary key (source, raw_name)` exactly, or PostgREST 42P10s.
  assert.deepStrictEqual(db.calls[0].opts, { onConflict: 'source,raw_name' });
});

atest('it chunks, and every row lands exactly once', async () => {
  const db = stubClient();
  const rows = planAliasWrites(
    Array.from({ length: 1250 }, (_, i) => alias('live_feed', `Team ${i}`, `team${i}`)),
    new Set(), 'T');
  const written = await writeAliases(db, rows, 500);
  assert.strictEqual(db.calls.length, 3);
  assert.deepStrictEqual(db.calls.map(c => c.rows.length), [500, 500, 250]);
  assert.strictEqual(written, 1250);
  const names = db.calls.flatMap(c => c.rows.map(r => r.raw_name));
  assert.strictEqual(new Set(names).size, 1250, 'no row written twice, none skipped');
});

atest('it counts what the database wrote, not what it was asked to write', async () => {
  // The bug this replaces: the counter added min(CHUNK, remaining) per
  // iteration whether or not the upsert touched anything, so a partial write
  // reported a full one and the run looked clean.
  const db = stubClient({ returns: rows => rows.slice(0, 2).map(r => ({ source: r.source })) });
  const rows = planAliasWrites(
    Array.from({ length: 10 }, (_, i) => alias('live_feed', `T${i}`, `t${i}`)), new Set(), 'T');
  assert.strictEqual(await writeAliases(db, rows, 10), 2);
});

atest('an error stops the run loudly and names the batch', async () => {
  const db = stubClient({ error: { message: 'permission denied for table team_alias' } });
  const rows = planAliasWrites([alias('live_feed', 'Leeds', 'leedsunited')], new Set(), 'T');
  await assert.rejects(() => writeAliases(db, rows), /upsert @0.*permission denied/);
});

atest('nothing to write means no request at all', async () => {
  const db = stubClient();
  assert.strictEqual(await writeAliases(db, []), 0);
  assert.strictEqual(await writeAliases(db, null), 0);
  assert.strictEqual(db.calls.length, 0);
});

Promise.resolve().then(() => setTimeout(() => console.log(`\n${passed} test(s) passed`), 0));
