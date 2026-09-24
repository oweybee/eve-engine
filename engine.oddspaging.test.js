'use strict';

/**
 * engine.oddspaging.test.js — the odds walk is keyset, not offset.
 *
 * THIS IS NOT A TEST ABOUT ARRAYS EITHER. computeValues' read of `odds` was
 * the statement the engine tick timed out on, about twice an hour through
 * 15-16 Sep 2026 (pg_stat_statements: 506,046 calls, max 7,986 ms against an
 * 8 s statement_timeout). Migration 128 adds the index that makes the filter
 * cheap; this pins the half that lives in code — each page carries `id > last`
 * rather than an OFFSET, so the sort covers only what is still ahead and a row
 * inserted mid-walk (the in-play worker writes `odds` every 30 s) cannot shift
 * the offsets under the reader.
 *
 * Run: node engine.oddspaging.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { pageByKey, PAGE_SIZE } = require('./lib/pagedRead');
const { fetchMatchesForComputation } = require('./computeValues');

/** A fake PostgREST builder over `rows`, honouring gt/order/limit/gte. */
function fakeTable(rows, log) {
  return () => {
    const filters = [];
    const call = { gt: null, range: null, limit: null, order: null };
    const q = {
      select() { return q; },
      gte(col, v) { filters.push(r => r[col] >= v); return q; },
      gt(col, v)  { call.gt = [col, v]; filters.push(r => r[col] > v); return q; },
      in(col, vs) { filters.push(r => vs.includes(r[col])); return q; },
      order(col, { ascending = true } = {}) {
        call.order = col;
        call.sort = (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1);
        return q;
      },
      range(from, to) { call.range = [from, to]; return q; },
      limit(n) { call.limit = n; return q; },
      then(resolve) {
        log.push(call);
        let out = rows.filter(r => filters.every(f => f(r)));
        if (call.sort) out = [...out].sort(call.sort);
        if (call.range) out = out.slice(call.range[0], call.range[1] + 1);
        else if (call.limit != null) out = out.slice(0, call.limit);
        resolve({ data: out, error: null });
      },
    };
    return q;
  };
}

const oddsRow = (i, matchId = 'm1') => ({
  id: `id-${String(i).padStart(6, '0')}`, match_id: matchId, bookmaker: `b${i % 7}`,
  market: 'h2h', market_line: null, home_odds: 2, draw_odds: 3, away_odds: 4,
  fetched_at: '2999-01-01T00:00:00Z',
});

test('pageByKey walks by `key > last` with a limit and never an offset', async () => {
  const rows = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) => oddsRow(i));
  const log = [];
  const out = await pageByKey(fakeTable(rows, log), 'id', 'probe');
  assert.equal(out.length, rows.length, 'every row returned');
  assert.equal(new Set(out.map(r => r.id)).size, rows.length, 'no row returned twice');
  assert.equal(log.length, 3, 'three pages: 1000, 1000, 5');
  assert.equal(log[0].gt, null, 'first page has no cursor');
  assert.deepEqual(log[1].gt, ['id', rows[PAGE_SIZE - 1].id], 'second page starts after the first page\'s last id');
  assert.deepEqual(log[2].gt, ['id', rows[2 * PAGE_SIZE - 1].id]);
  for (const c of log) {
    assert.equal(c.range, null, 'no .range() — OFFSET is the thing being removed');
    assert.equal(c.limit, PAGE_SIZE);
    assert.equal(c.order, 'id');
  }
});

test('pageByKey stops on a short page and returns nothing for an empty table', async () => {
  const log = [];
  const out = await pageByKey(fakeTable([], log), 'id', 'probe');
  assert.deepEqual(out, []);
  assert.equal(log.length, 1);
});

test('pageByKey names the read in an error and refuses a key it cannot see', async () => {
  const erroring = () => ({
    gt() { return this; }, order() { return this; },
    limit() { return this; },
    then(resolve) { resolve({ data: null, error: { message: 'boom' } }); },
  });
  await assert.rejects(() => pageByKey(erroring, 'id', 'fetchMatchesForComputation[odds]'),
    /fetchMatchesForComputation\[odds\]: boom/);

  // A full page whose rows lack the key cannot advance: say so rather than
  // looping on `gt(key, undefined)` for ever.
  const keyless = Array.from({ length: PAGE_SIZE }, () => ({ x: 1 }));
  await assert.rejects(() => pageByKey(fakeTable(keyless, []), 'id', 'probe'),
    /page key 'id' is not in the selected columns/);
});

test('fetchMatchesForComputation pages odds by id, selects the cursor column, and keeps only slate matches', async () => {
  const matches = [
    { id: 'm1', kickoff_at: '2999-01-01T12:00:00Z', status: 'scheduled' },
    { id: 'm2', kickoff_at: '2999-01-01T13:00:00Z', status: 'scheduled' },
  ];
  const odds = [
    ...Array.from({ length: PAGE_SIZE + 3 }, (_, i) => oddsRow(i, i % 2 ? 'm1' : 'm2')),
    oddsRow(9000, 'not-on-the-slate'),
  ];
  const log = { matches: [], odds: [] };
  const supabase = {
    from(table) {
      if (table === 'matches') return fakeTable(matches, log.matches)();
      if (table === 'odds')    return fakeTable(odds, log.odds)();
      throw new Error(`unexpected table ${table}`);
    },
  };
  const out = await fetchMatchesForComputation(supabase, ['scheduled']);
  assert.equal(out.length, 2, 'both slate matches priced');
  assert.equal(out.reduce((n, m) => n + m.odds.length, 0), PAGE_SIZE + 3,
    'every odds row on the slate is attached; the off-slate row is dropped');
  assert.equal(log.odds.length, 2, 'two pages of odds');
  assert.equal(log.odds[0].gt, null);
  assert.equal(log.odds[1].gt[0], 'id', 'second page is keyset on id');
  assert.equal(log.odds[1].range, null, 'no offset paging');
});

test('the source selects `id` on the odds read and does not .range() it', () => {
  // COMMENTS STRIPPED BEFORE SCANNING. The first cut of this case failed on
  // the comment in computeValues.js explaining the `.range()` it replaced —
  // a ratchet that fires on its own documentation is one the next person
  // deletes (lib/pickWindow.test.js in eve-frontend learned this first).
  const src = fs.readFileSync(require.resolve('./computeValues.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fn = src.slice(src.indexOf('async function fetchMatchesForComputation'),
                       src.indexOf('function computeConsensus'));
  assert.ok(/\.from\('odds'\)\s*\.select\('id, match_id/.test(fn),
    'the odds select must begin with id — pageByKey reads the cursor off the row');
  assert.ok(!/\.range\(/.test(fn), 'no .range() left in the odds walk');
  assert.ok(/pageByKey\(/.test(fn), 'the walk goes through lib/pagedRead.pageByKey');
});
