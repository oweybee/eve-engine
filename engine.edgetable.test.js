'use strict';
// lib/edgeTable — the Discord port of eve-frontend lib/edgeTable.ts.
// The figures pinned here are the site's own, so the two cannot drift silently.

const assert = require('assert');
const {
  buildEdgeTable, edgeSummary, devigMatch, beyondChanceBar, chanceCount, MIN_RANKED_MATCHES,
} = require('./lib/edgeTable');
const { edgePost, edgeFinding } = require('./lib/discordDigest');
const { divisionLabel } = require('./lib/edgeTable');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

t('the Bonferroni bar over 116 clubs is the 3.520 the site quotes', () => {
  assert(close(beyondChanceBar(116), 3.520, 2e-3), `got ${beyondChanceBar(116)}`);
  assert.strictEqual(beyondChanceBar(1), null);   // fails closed: nothing is marked
});

t('chance puts about 5.3 of 116 clubs past |z| = 2', () => {
  assert(close(chanceCount(116, 2), 5.28, 0.02), `got ${chanceCount(116, 2)}`);
});

t('the expectation is Shin-de-vigged, not 1/odds', () => {
  const p = devigMatch({ close_home: 2.0, close_draw: 3.5, close_away: 4.0 });
  // 1/2.0 = 0.5 carries the margin; the fair home probability must sit below it
  assert(p.home < 0.5 && p.home > 0.45, `home ${p.home}`);
  assert(p.home + p.away < 1);
  assert.strictEqual(devigMatch({ close_home: 2.0, close_draw: null, close_away: 4.0 }), null);
});

const m = (id, home, away, ftr, h = 2.0, d = 3.5, a = 4.0) => ({
  id: String(id), div: 'E0', country: 'England', season: '2026/27', match_date: `2026-09-${String(id).padStart(2, '0')}`,
  home_team: home, away_team: away, ftr, close_home: h, close_draw: d, close_away: a,
});

t('money settles at the quoted close and an unpriced match is counted, not dropped', () => {
  const tbl = buildEdgeTable([m(1, 'A', 'B', 'H'), m(2, 'A', 'C', 'A'), m(3, 'A', 'D', 'H', null)]);
  const A = tbl.teams.find(r => r.team === 'A');
  assert.strictEqual(A.played, 3);
  assert.strictEqual(A.unpriced, 1);
  assert(close(A.profitUnits, 1.0 - 1));          // won at 2.0 (+1), lost (-1)
  assert.strictEqual(tbl.unpriceable, 1);
});

t('only clubs with enough priced matches are ranked', () => {
  const rows = [];
  for (let i = 0; i < MIN_RANKED_MATCHES; i++) rows.push(m(i + 1, 'Busy', `Opp${i}`, 'H'));
  rows.push(m(20, 'Rare', 'Busy2', 'H'));
  const s = edgeSummary(rows);
  assert(s.top.some(r => r.team === 'Busy'));
  assert(!s.top.concat(s.bottom).some(r => r.team === 'Rare'));
});

t('the post never states a fixed |z| bar as the finding and is copy-clean', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) { rows.push(m(i + 1, 'Hot', `X${i}`, 'H')); rows.push(m(i + 30, 'Cold', `Y${i}`, 'A')); }
  for (let i = 0; i < 8; i++) rows.push(m(i + 60, `Y${i}`, `X${i}`, i % 2 ? 'H' : 'D'));
  const s = edgeSummary(rows);
  const p = edgePost(s, '2026/27', divisionLabel);
  const txt = JSON.stringify(p);
  assert(txt.includes('Hot') && txt.includes('Cold'));
  assert(/allows for testing \d+ clubs/.test(edgeFinding(s)));
  assert(!/profit/i.test(txt));
});

t('a season with fewer than two ranked clubs posts nothing', () => {
  assert.strictEqual(edgePost(edgeSummary([m(1, 'A', 'B', 'H')]), '2026/27', divisionLabel), null);
});

console.log(`\n${n} passed`);
