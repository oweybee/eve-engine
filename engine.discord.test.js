'use strict';
// The Discord channel's rails. Runs before every post (see post-to-discord.yml)
// as well as in `npm test`: these are the only checks between an unattended
// poster and a public channel.

const assert = require('assert');
const {
  signalPost, resultPost, weeklyRecordPost, fairPrice, assertClean, ComposeRefusal,
  selectionText, threadName,
} = require('./lib/discordCompose');
const { plan, numEnv } = require('./postToDiscord');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const match = {
  goals_home: 2, goals_away: 1,
  home_team: { name: 'Nantes' }, away_team: { name: 'Reims' }, league: { name: 'Ligue 2' },
};
const base = {
  id: 'a', market: 'h2h', outcome: 'home', market_line: null,
  detected_odds: 2.27, detected_edge: 0.061, mxs: 80, mxs_band: 'PRIME', gap_basis: 'devigged',
  bookmaker: 'betano', kickoff_at: '2026-10-10T12:00:00Z', detected_at: '2026-10-08T12:00:00Z',
  phase: 'prematch', is_mover: false, match,
};
const all = p => JSON.stringify(p);

t('fair price inverts edge = p·odds − 1', () => {
  assert.strictEqual(fairPrice(2.27, 0.061).toFixed(3), (2.27 / 1.061).toFixed(3));
  assert.strictEqual(fairPrice(1, 0.1), null);
  assert.strictEqual(fairPrice('x', 0.1), null);
});

t('every signal post prints the fair price, the book and 18+', () => {
  const p = signalPost(base, 'PRIME');
  assert(all(p).includes('Fair price'));
  assert(all(p).includes('2.14'));
  assert(all(p).includes('18+'));
  assert(all(p).toLowerCase().includes('best price ('));
});

t('never "our price"', () => {
  for (const r of ['PRIME', 'EDGE']) assert(!all(signalPost(base, r)).toLowerCase().includes('our price'));
});

t('EDGE carries its scope line, PRIME does not', () => {
  assert(all(signalPost(base, 'EDGE')).includes('reported separately'));
  assert(!all(signalPost(base, 'PRIME')).includes('reported separately'));
});

t('only backed rungs can be composed', () => {
  assert.throws(() => signalPost(base, 'WATCH'));
  assert.throws(() => signalPost(base, null));
});

t('banned words refuse rather than soften', () => {
  assert.throws(() => assertClean({ x: 'a guaranteed winner' }), ComposeRefusal);
  assert.throws(() => assertClean({ x: 'this is our price' }), ComposeRefusal);
  assert.throws(() => assertClean({ x: 'Brier 0.30' }), ComposeRefusal);
  assert.doesNotThrow(() => assertClean({ x: 'Blockbuster' }));   // word boundary
});

t('a loss posts with the same layout as a win', () => {
  const win = resultPost({ ...base, result: 'win', closing_odds: 2.1 }, 'PRIME');
  const loss = resultPost({ ...base, result: 'loss', closing_odds: 2.1 }, 'PRIME');
  assert.strictEqual(win.embeds[0].fields.length, loss.embeds[0].fields.length);
  assert(all(loss).includes('LOST'));
  assert(all(loss).includes('-1.00u'));
  assert(all(win).includes('+1.27u'));
});

t('a pending row cannot be announced', () => {
  assert.throws(() => resultPost({ ...base, result: 'pending' }, 'PRIME'));
});

t('selection text reads like English', () => {
  assert.strictEqual(selectionText(base), 'Nantes to win');
  assert.strictEqual(selectionText({ ...base, market: 'totals', outcome: 'over', market_line: 2.5 }), 'Over 2.5 goals');
  assert.strictEqual(selectionText({ ...base, outcome: 'btts_no' }), 'Both teams to score: No');
  assert(threadName(base).length <= 100);
});

const bands = [
  { band_key: 'prime', band_label: 'PRIME', sort_order: 1, published: true, record_role: 'headline',
    settled_fixtures: 58, wins: 35, losses: 24, win_rate: 0.593, breakeven_strike: 0.444, yield: 0.27,
    units: 15.88, insufficient: true, insufficient_reason: '58 settled fixtures, below the 100 required.',
    headline_scope_note: 'Our published record covers PRIME signals only.' },
  { band_key: 'edge', band_label: 'EDGE', sort_order: 2, published: true, record_role: 'reference',
    settled_fixtures: 28, wins: 15, losses: 13, win_rate: 0.536, breakeven_strike: 0.428, yield: 0.28,
    units: 7.77, insufficient: true, insufficient_reason: '28 settled fixtures.', headline_scope_note: null },
  { band_key: 'all_backed', band_label: 'PRIME + EDGE', sort_order: 4, published: false, record_role: 'internal',
    settled_fixtures: 86, wins: 50, losses: 37, win_rate: 0.575, breakeven_strike: 0.439, yield: 0.27,
    units: 23.65, insufficient: true, insufficient_reason: 'x', headline_scope_note: null },
];

t('weekly record never shows the internal merged row', () => {
  const p = weeklyRecordPost(bands);
  assert(!all(p).includes('PRIME + EDGE'));
  assert.strictEqual(p.embeds[0].fields.length, 2);
});

t('weekly record withholds yield until the gate clears, and prints the scope note', () => {
  const p = all(weeklyRecordPost(bands));
  assert(!p.includes('+27.0%'));
  assert(p.includes('not published yet'));
  assert(p.includes('covers PRIME signals only'));
  assert(p.includes('needed to break even'));
});

t('weekly record shows yield once a band clears', () => {
  const cleared = bands.map(b => b.band_key === 'prime' ? { ...b, insufficient: false } : b);
  assert(all(weeklyRecordPost(cleared)).includes('+27.0%'));
});

t('public feed waits for the delay; Plus does not; nothing inside 10 min of kick-off', () => {
  const now = Date.parse('2026-10-08T12:10:00Z');
  const fresh = { ...base, id: 'f', detected_at: '2026-10-08T12:05:00Z' };
  const old = { ...base, id: 'o', match_id: 'm2', detected_at: '2026-10-08T11:00:00Z' };
  const late = { ...base, id: 'l', match_id: 'm3', kickoff_at: '2026-10-08T12:15:00Z' };
  const { plus, free } = plan([{ ...fresh, match_id: 'm1' }, old, late], now);
  assert.deepStrictEqual(plus.map(s => s.id).sort(), ['f', 'o']);
  assert.deepStrictEqual(free.map(s => s.id), ['o']);
});

t('non-backed and in-play rows never plan', () => {
  const now = Date.parse('2026-10-08T12:10:00Z');
  const weak = { ...base, id: 'w', match_id: 'm4', detected_edge: 0.02 };
  const live = { ...base, id: 'i', match_id: 'm5', phase: 'inplay' };
  const { plus } = plan([weak, live], now);
  assert.strictEqual(plus.length, 0);
});

t('a blank env var falls back to the default rather than 0', () => {
  process.env.__T = ''; assert.strictEqual(numEnv('__T', 30), 30);
  process.env.__T = 'x'; assert.strictEqual(numEnv('__T', 30), 30);
  process.env.__T = '45'; assert.strictEqual(numEnv('__T', 30), 45);
  delete process.env.__T;
});

console.log(`\n${n} passed`);
