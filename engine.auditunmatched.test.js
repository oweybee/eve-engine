'use strict';

/**
 * engine.auditunmatched.test.js — the four silences behind "N unmatched".
 *
 * `resolveMatch` returns one bit and that bit has four causes. Two are work
 * (a missing alias, a stale kickoff) and two are deliberate (past the horizon,
 * a competition between rounds). Reporting them as one number is the failure
 * /api/inplay's `source` block was written to end.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  classifyEvent, summarise, similarity, nearestKey,
  OUTCOMES, HORIZON_HOURS, MATCH_WINDOW_MIN,
} = require('./scripts/auditUnmatchedEvents');

const HOUR = 3_600_000;
const now = Date.UTC(2026, 7, 22, 12, 0, 0);
const ev = (home, away, hoursOut) => ({
  home_team: home, away_team: away,
  commence_time: new Date(now + hoursOut * HOUR).toISOString(),
});
// clubKey('Arsenal') -> 'arsenal'; the index is keyed on the pair.
const idxWith = (pairs) => new Map(pairs.map(([k, ko]) => [k, [{ id: 'm1', ko }]]));
const ctx = (over = {}) => ({ now, leagueHasUpcoming: true, homeKeys: new Set(['arsenal', 'chelsea', 'manchesterunited']), ...over });

test('a fixture we hold, at the right time, MATCHES', () => {
  const idx = idxWith([['arsenal|chelsea', now + 2 * HOUR]]);
  const r = classifyEvent(ev('Arsenal', 'Chelsea', 2), idx, ctx());
  assert.equal(r.outcome, 'MATCHED');
  assert.equal(r.gapMin, 0);
});

test('the window is tolerant, and then it is not', () => {
  const idx = idxWith([['arsenal|chelsea', now + 2 * HOUR]]);
  const inside = classifyEvent(ev('Arsenal', 'Chelsea', 2 + (MATCH_WINDOW_MIN - 1) / 60), idx, ctx());
  assert.equal(inside.outcome, 'MATCHED');
  const outside = classifyEvent(ev('Arsenal', 'Chelsea', 2 + (MATCH_WINDOW_MIN + 30) / 60), idx, ctx());
  assert.equal(outside.outcome, 'TIME_GAP');
  assert.ok(outside.gapMin > MATCH_WINDOW_MIN);
});

test('A CLOCK PROBLEM IS NOT A NAME PROBLEM', () => {
  // The names are ours — only the kickoff disagrees, which is a rescheduled
  // fixture we did not re-ingest. Filing it under NAME_MISMATCH sends the
  // reader to the alias table for nothing.
  const idx = idxWith([['arsenal|chelsea', now + 26 * HOUR]]);
  const r = classifyEvent(ev('Arsenal', 'Chelsea', 2), idx, ctx());
  assert.equal(r.outcome, 'TIME_GAP');
  assert.match(r.detail, /window is 90m/);
});

test('OUT_OF_SEASON IS RULED OUT BEFORE A NAME MISS, not after', () => {
  // A competition between rounds has no fixture to index against, so it looks
  // exactly like a spelling problem. UCL/UECL is the case that matters.
  const r = classifyEvent(ev('Real Madrid', 'Bayern Munich', 5), new Map(),
    ctx({ leagueHasUpcoming: false }));
  assert.equal(r.outcome, 'OUT_OF_SEASON');
  assert.match(r.detail, /no upcoming fixture/);
});

test('BEYOND_HORIZON is thrift, not a defect', () => {
  const r = classifyEvent(ev('Arsenal', 'Spurs', HORIZON_HOURS + 24), new Map(), ctx());
  assert.equal(r.outcome, 'BEYOND_HORIZON');
  assert.match(r.detail, /horizon is 72h/);
});

test('an event inside the horizon with no fixture IS a name miss, and it suggests the alias', () => {
  const r = classifyEvent(ev('Man Utd', 'Chelsea', 5), new Map(), ctx());
  assert.equal(r.outcome, 'NAME_MISMATCH');
  assert.ok(r.suggestion, 'no alias suggested');
  assert.match(r.suggestion, /manchesterunited/);
});

test('THE SUGGESTION NEVER BECOMES A MATCH', () => {
  // A fuzzy matcher that accepted 0.8 would print a live price under the wrong
  // game. The distance names a candidate for a human; it decides nothing.
  const src = fs.readFileSync(require.resolve('./scripts/auditUnmatchedEvents.js'), 'utf8');
  const classify = src.slice(src.indexOf('function classifyEvent'), src.indexOf('const OUTCOMES'));
  assert.ok(!/similarity\s*[><]=?/.test(classify),
    'classifyEvent must not branch on similarity — the matcher stays exact');
});

test('similarity is bounded and nearestKey has a floor', () => {
  assert.equal(similarity('arsenal', 'arsenal'), 1);
  assert.ok(similarity('arsenal', 'chelsea') < 0.5);
  assert.equal(similarity('', ''), 1);
  assert.equal(nearestKey('zzzzzzzzzz', new Set(['arsenal'])), null, 'floor did not hold');
});

test('the summary splits actionable from deliberate', () => {
  const rows = [
    { outcome: 'MATCHED' }, { outcome: 'MATCHED' },
    { outcome: 'NAME_MISMATCH' }, { outcome: 'TIME_GAP' },
    { outcome: 'BEYOND_HORIZON' }, { outcome: 'OUT_OF_SEASON' },
  ];
  const s = summarise(rows);
  assert.equal(s.total, 6);
  assert.equal(s.actionable, 2, 'horizon and season must not count as work');
  assert.ok(Math.abs(s.matchRate - 2 / 6) < 1e-9);
});

test('an empty sweep reports no match rate rather than 0%', () => {
  // 0% reads as "everything failed"; null reads as "nothing was asked".
  assert.equal(summarise([]).matchRate, null);
});

test('it mirrors the ingest constants rather than inventing its own', () => {
  const ingest = fs.readFileSync(require.resolve('./ingestOddsApi.js'), 'utf8');
  const hz = ingest.match(/ODDS_API_HORIZON_HOURS\s*\|\|\s*'(\d+)'/);
  const win = ingest.match(/MATCH_WINDOW_MIN\s*=\s*(\d+)/);
  assert.ok(hz && win, 'could not read the ingest constants');
  assert.equal(HORIZON_HOURS, Number(hz[1]), 'horizon drifted from ingestOddsApi.js');
  assert.equal(MATCH_WINDOW_MIN, Number(win[1]), 'window drifted from ingestOddsApi.js');
});

test('every outcome the classifier can return is in OUTCOMES', () => {
  const src = fs.readFileSync(require.resolve('./scripts/auditUnmatchedEvents.js'), 'utf8');
  const classify = src.slice(src.indexOf('function classifyEvent'), src.indexOf('const OUTCOMES'));
  for (const m of classify.matchAll(/outcome:\s*'([A-Z_]+)'/g)) {
    assert.ok(OUTCOMES.includes(m[1]), `${m[1]} is returned but missing from OUTCOMES, so it would not be tabulated`);
  }
});

// ---------------------------------------------------------------------------
// pageAll — the read that made every other number in this file wrong
//
// The first cut of `loadFixtureIndex` was one `.limit(1000)` with no order and
// no paging. PostgREST caps a response at 1000 rows whatever `.limit()` says,
// production holds 8,885 upcoming fixtures, and the 133 inside the horizon —
// the only ones that CAN match — were mostly not in the arbitrary slice it got.
// The 23:31 run therefore reported OUT_OF_SEASON 252 with `epl` at 14 on a
// night the Premier League played, and four leagues came back MATCHED and
// OUT_OF_SEASON at once, which is impossible and is what truncation looks like
// from outside.
//
// So these pin the two properties that failure needed: it must keep reading
// past the cap, and it must decide "done" by IDs it has already seen rather
// than by page length — because a layer that answers the URL and ignores the
// Range header serves page 0 for ever, and a length check loops to MAX_PAGES
// while multiplying the corpus.
// ---------------------------------------------------------------------------
const { pageAll, PAGE, MAX_PAGES } = require('./scripts/auditUnmatchedEvents');

/** A fake PostgREST that honours Range, like the real one. */
const honest = (total) => {
  let calls = 0;
  const q = () => ({
    range: async (from, to) => {
      calls++;
      const rows = [];
      for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ id: `r${i}` });
      return { data: rows, error: null };
    },
  });
  return { q, calls: () => calls };
};

test('pageAll reads PAST the 1000-row cap', async () => {
  const { q } = honest(2345);
  const { rows, truncated } = await pageAll(q, 'x');
  assert.strictEqual(rows.length, 2345);
  assert.strictEqual(truncated, false);
});

test('a short page ends it — no wasted request after the tail', async () => {
  const h = honest(1500);
  await pageAll(h.q, 'x');
  assert.strictEqual(h.calls(), 2);
});

test('an exact multiple of the page size still terminates', async () => {
  const h = honest(PAGE * 2);
  const { rows, truncated } = await pageAll(h.q, 'x');
  assert.strictEqual(rows.length, PAGE * 2);
  assert.strictEqual(truncated, false);
});

test('a layer that IGNORES Range cannot multiply the corpus', async () => {
  // Serves page 0 for ever — a cache, a proxy, or a fixture route keyed on URL.
  let calls = 0;
  const q = () => ({
    range: async () => {
      calls++;
      return { data: Array.from({ length: PAGE }, (_, i) => ({ id: `r${i}` })), error: null };
    },
  });
  const { rows, truncated } = await pageAll(q, 'x');
  assert.strictEqual(rows.length, PAGE, 'deduped by id, not counted by page length');
  assert.strictEqual(truncated, false);
  assert.strictEqual(calls, 2, 'stops on the first page that adds nothing fresh');
});

test('truncation at MAX_PAGES is REPORTED, never silent', async () => {
  const { q } = honest(PAGE * (MAX_PAGES + 5));
  const { truncated } = await pageAll(q, 'x');
  assert.strictEqual(truncated, true);
});

test('an error is thrown with the label, not swallowed into an empty index', async () => {
  const q = () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) });
  await assert.rejects(() => pageAll(q, 'matches'), /audit\[matches\]: boom/);
});
