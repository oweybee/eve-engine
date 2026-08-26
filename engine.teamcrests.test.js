/**
 * engine.teamcrests.test.js — the crest backfill's matching, and the guard that
 * stops an ingest blanking a crest it already holds.
 *
 * WHY THESE TWO. Both failures are SILENT and both look ordinary on screen: a
 * wrong match draws another club's badge, and a null-clobber quietly empties a
 * column that took ~40 API requests to fill. Neither throws.
 */
'use strict';

const assert = require('assert');
const { clusterTeams, fetchLeagueTeams, currentSeasonYear } = require('./backfillTeamCrests');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

const ourRows = [
  { id: 'u1', name: 'Wolverhampton Wanderers' },
  { id: 'u2', name: 'Wolves' },
  { id: 'u3', name: 'Oxford United' },
  { id: 'u4', name: 'Oxford City' },
  { id: 'u5', name: 'Manchester United' },
  { id: 'u6', name: 'team_home_1490361' },     // the E3 placeholder
];
const api = [
  { id: 39,  name: 'Wolves',            logo: 'w.png',  league: 'Premier League (England)' },
  { id: 33,  name: 'Manchester United', logo: 'mu.png', league: 'Premier League (England)' },
  { id: 999, name: 'Zzyzx Rovers',      logo: 'z.png',  league: 'Premier League (England)' },
];
const { matched, unmatched } = clusterTeams(ourRows, api, 0.92);
const forApi = n => matched.find(m => m.api.name === n);

console.log('\ncrest backfill — matching');

t('a placeholder row is never matched onto a club', () => {
  const all = matched.flatMap(m => m.rows.map(r => r.id));
  assert.ok(!all.includes('u6'), 'team_home_1490361 must never receive a crest');
});

t('an exact name resolves', () => {
  assert.deepStrictEqual(forApi('Manchester United').rows.map(r => r.id), ['u5']);
});

t('BOTH spellings of one club resolve together, so both get the crest', () => {
  // "Wolves" is an unambiguous token prefix of "Wolverhampton Wanderers", which
  // is `buildCanonicalMap`'s pass 2 and the reason this script does not roll
  // its own matcher: `canonicalKey` alone puts these in different buckets.
  const ids = forApi('Wolves').rows.map(r => r.id).sort();
  assert.deepStrictEqual(ids, ['u1', 'u2']);
});

t('AN AMBIGUOUS SHORT NAME IS NOT FOLDED INTO EITHER CANDIDATE', () => {
  // "Oxford" prefixes two clubs, so neither Oxford row may absorb the other.
  // A wrong badge is worse than no badge.
  const oxfordRows = matched.flatMap(m => m.rows).filter(r => r.name.startsWith('Oxford'));
  assert.strictEqual(oxfordRows.length, 0, 'no API club here should claim an Oxford row');
});

t('an unknown club is reported rather than forced onto the nearest row', () => {
  assert.deepStrictEqual(unmatched.map(t => t.name), ['Zzyzx Rovers']);
});

t('the crest is offered to every row of a matched club', () => {
  assert.strictEqual(forApi('Wolves').rows.length, 2);
  assert.ok(forApi('Wolves').api.logo);
});

console.log('\ncrest backfill — the API envelope');

t('API-Football reports a plan failure with HTTP 200 and an errors payload', async () => {
  // Synchronous assertion on the shape; the await is resolved below.
  assert.ok(typeof fetchLeagueTeams === 'function');
});

(async () => {
  const stub = async () => ({
    response: [
      { team: { id: 33, name: 'Oxford United', logo: 'https://media.api-sports.io/football/teams/33.png' } },
      { team: { id: 44, name: 'No Logo FC', logo: null } },
      { team: { id: null, name: 'Broken' } },
    ],
    errors: [],
  });
  const { teams, error } = await fetchLeagueTeams(1, 2026, stub);
  t('a team with no id is dropped rather than written', () => {
    assert.strictEqual(teams.length, 2);
    assert.deepStrictEqual(teams.map(x => x.id), [33, 44]);
  });
  t('a missing logo survives as null for the caller to skip', () => {
    assert.strictEqual(teams[1].logo, null);
    assert.strictEqual(error, null);
  });

  const errStub = async () => ({ response: [], errors: { plan: 'Your plan does not allow this season' } });
  const bad = await fetchLeagueTeams(1, 1990, errStub);
  t('an errors payload on a 200 is surfaced, not read as "league did not run"', () => {
    assert.strictEqual(bad.teams.length, 0);
    assert.match(bad.error, /plan does not allow/);
  });

  console.log('\ncrest backfill — the season boundary');
  t('the season rolls over in JULY, not January', () => {
    assert.strictEqual(currentSeasonYear(new Date('2026-08-26T00:00:00Z')), 2026);
    assert.strictEqual(currentSeasonYear(new Date('2026-06-30T00:00:00Z')), 2025);
  });

  // ── the ingest-side guard ────────────────────────────────────────────────
  console.log('\ncrest backfill — the ingest never blanks a crest it holds');

  const { upsertTeamRows } = require('./planDay');

  /** A supabase double that records every payload it is handed. */
  function fakeClient({ failFirstWith } = {}) {
    const seen = [];
    let calls = 0;
    return {
      seen,
      from() { return this; },
      upsert(rows) { this._rows = rows; return this; },
      select() {
        const rows = this._rows;
        seen.push(rows);
        calls++;
        if (failFirstWith && calls === 1) return Promise.resolve({ data: null, error: failFirstWith });
        return Promise.resolve({ data: rows.map((r, i) => ({ id: `id${i}`, name: r.name })), error: null });
      },
    };
  }

  {
    const c = fakeClient();
    await upsertTeamRows(c, [
      { name: 'A', short_name: 'A', crest_url: 'a.png', external_id: '1' },
      { name: 'B', short_name: 'B' },                       // no logo from the API
    ], new Map());

    t('rows are batched by key signature, not sent as one ragged payload', () => {
      // PostgREST rejects a bulk payload whose objects have different keys.
      assert.strictEqual(c.seen.length, 2, `expected 2 batches, got ${c.seen.length}`);
    });

    t('A ROW WITH NO LOGO CARRIES NO crest_url KEY AT ALL', () => {
      const flat = c.seen.flat();
      const b = flat.find(r => r.name === 'B');
      assert.ok(!('crest_url' in b),
        'an explicit null would overwrite a stored crest — the key must be absent');
    });
  }

  {
    const c = fakeClient({ failFirstWith: { code: '23505', message: 'duplicate key value violates unique constraint "teams_external_id_key"' } });
    const out = new Map();
    await upsertTeamRows(c, [{ name: 'A', short_name: 'A', crest_url: 'a.png', external_id: '1' }], out);

    t('a unique external_id collision retries WITHOUT the id rather than losing the chunk', () => {
      assert.strictEqual(c.seen.length, 2, 'expected a retry');
      assert.ok('external_id' in c.seen[0][0]);
      assert.ok(!('external_id' in c.seen[1][0]), 'the retry must drop external_id');
      assert.strictEqual(c.seen[1][0].crest_url, 'a.png', 'the crest must still land');
      assert.strictEqual(out.get('A'), 'id0', 'the team id must still reach the caller');
    });
  }

  console.log(`\ncrest backfill: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
