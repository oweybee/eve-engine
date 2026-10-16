'use strict';
// fetchMatchesForComputation walks `odds` by keyset on fetched_at. This fakes
// PostgREST so the walk can be checked for skips and duplicates at page
// boundaries that land inside a fetched_at tie.
const assert = require('assert');
const { fetchMatchesForComputation } = require('./computeValues');

function fakeClient(matches, odds) {
  return {
    from(table) {
      const q = { filters: [], lim: Infinity };
      const api = {
        select() { return api; },
        in(col, vals) { q.filters.push(r => vals.includes(r[col])); return api; },
        gte(col, v) { q.filters.push(r => r[col] >= v); return api; },
        order() { return api; },
        limit(n) { q.lim = n; return api; },
        then(res, rej) {
          let rows = (table === 'matches' ? matches : odds).filter(r => q.filters.every(f => f(r)));
          if (table === 'odds') rows = rows.slice().sort((a, b) =>
            a.fetched_at < b.fetched_at ? -1 : a.fetched_at > b.fetched_at ? 1 : a.id < b.id ? -1 : 1);
          return Promise.resolve({ data: rows.slice(0, q.lim), error: null }).then(res, rej);
        },
      };
      return api;
    },
  };
}

(async () => {
  const now = Date.now();
  const matches = [{ id: 'm1', status: 'scheduled' }, { id: 'm2', status: 'scheduled' }];
  const odds = [];
  // 2,537 rows in groups of 50 sharing a timestamp, so page edges fall inside ties.
  for (let i = 0; i < 2537; i++) {
    const ts = new Date(now - 3_600_000 + Math.floor(i / 50) * 1000).toISOString();
    odds.push({ id: `o${String(i).padStart(5, '0')}`, match_id: i % 3 === 0 ? 'm1' : i % 3 === 1 ? 'm2' : 'other', fetched_at: ts });
  }
  // one stale row outside the window
  odds.push({ id: 'old', match_id: 'm1', fetched_at: new Date(now - 48 * 3_600_000).toISOString() });

  const out = await fetchMatchesForComputation(fakeClient(matches, odds));
  const got = out.flatMap(m => m.odds.map(o => o.id));
  const want = odds.filter(o => o.id !== 'old' && o.match_id !== 'other').map(o => o.id);
  assert.strictEqual(new Set(got).size, got.length, 'no duplicates');
  assert.deepStrictEqual(got.slice().sort(), want.slice().sort(), 'every in-window row, nothing stale');
  console.log('engine.oddskeyset.test.js: ok');
})().catch(e => { console.error(e); process.exit(1); });
