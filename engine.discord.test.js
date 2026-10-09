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

t('every eligible signal posts at once: no delay, no early tier; nothing inside 10 min of kick-off', () => {
  const now = Date.parse('2026-10-08T12:10:00Z');
  const fresh = { ...base, id: 'f', match_id: 'm1', detected_at: '2026-10-08T12:09:00Z' };
  const old = { ...base, id: 'o', match_id: 'm2', detected_at: '2026-10-08T11:00:00Z' };
  const late = { ...base, id: 'l', match_id: 'm3', kickoff_at: '2026-10-08T12:15:00Z' };
  assert.deepStrictEqual(plan([fresh, old, late], now).map(s => s.id).sort(), ['f', 'o']);
});

t('no post carries early-access or tier-timing copy', () => {
  const p = all(signalPost(base, 'PRIME')).toLowerCase();
  assert(!p.includes('saw this first') && !p.includes('early'));
});

t('non-backed and in-play rows never plan', () => {
  const now = Date.parse('2026-10-08T12:10:00Z');
  const weak = { ...base, id: 'w', match_id: 'm4', detected_edge: 0.02 };
  const live = { ...base, id: 'i', match_id: 'm5', phase: 'inplay' };
  assert.strictEqual(plan([weak, live], now).length, 0);
});

t('a blank env var falls back to the default rather than 0', () => {
  process.env.__T = ''; assert.strictEqual(numEnv('__T', 30), 30);
  process.env.__T = 'x'; assert.strictEqual(numEnv('__T', 30), 30);
  process.env.__T = '45'; assert.strictEqual(numEnv('__T', 30), 45);
  delete process.env.__T;
});

// ── Digests: #hit-rates trends and #market-pulse movers ────────────────────
const { formOf, trendsPost, priceMoves, moversPost } = require('./lib/discordDigest');

const day = i => new Date(Date.UTC(2026, 9, 1 - i, 15)).toISOString();
// Team H: 12 games. Of the newest 10, 8 had 3+ goals and both scoring; the
// two oldest were 1-0s and must not count. Team A likewise.
const hist = [];
for (let i = 0; i < 12; i++) {
  const big = i !== 3 && i !== 7 && i < 10;
  hist.push({ id: `h${i}`, kickoff_at: day(i), home_team_id: 'H', away_team_id: `x${i}`, goals_home: big ? 2 : 1, goals_away: big ? 1 : 0 });
  hist.push({ id: `a${i}`, kickoff_at: day(i), home_team_id: `y${i}`, away_team_id: 'A', goals_home: big ? 2 : 0, goals_away: big ? 2 : 0 });
}
const fx = { id: 'F', kickoff_at: '2026-10-10T14:00:00Z', home_team_id: 'H', away_team_id: 'A',
  home_team: { name: 'Hull' }, away_team: { name: 'Leeds' } };

t('form counts only the last 10 completed games and needs at least 8', () => {
  const f = formOf('H', hist);
  assert.strictEqual(f.n, 10); assert.strictEqual(f.over25, 8); assert.strictEqual(f.btts, 8);
  assert.strictEqual(formOf('H', hist.filter(m => Number(m.id.slice(1)) < 7)), null);
});

t('each team gets a 🟩/🟥 strip, oldest game first', () => {
  const f = formOf('H', hist);
  // newest 10 are i=0..9; misses at i=3 and i=7. Oldest first means i=9 first.
  assert.deepStrictEqual(f.seq.over25, [9,8,7,6,5,4,3,2,1,0].map(i => i !== 3 && i !== 7));
  const s = all(trendsPost([fx], hist));
  assert(s.includes('🟩🟩🟥🟩🟩🟩🟥🟩🟩🟩'));
  assert(!s.includes('⬜'));
});

t('each trend is its own card, footer on the last one only', () => {
  const p = trendsPost([fx], hist);
  assert(p.embeds.length >= 2);
  assert(p.embeds.slice(0, -1).every(e => !e.footer));
  assert(p.embeds.at(-1).footer.text.includes('18+'));
});

t('trends card shows counts out of games played, with no prices', () => {
  const p = trendsPost([fx], hist);
  const s = all(p);
  assert(s.includes('8/10'));
  assert(s.includes('Hull v Leeds'));
  assert(!/\b\d\.\d\d\b/.test(s.replace(/<t:\d+:t>/g, '')), 'no decimal prices in a trends card');
  assert(s.includes('18+'));
});

t('a quiet day posts nothing rather than 50/50s', () => {
  // alternate 2-1 and 1-0: 3+ goals, both scoring and 2-or-fewer all sit at 50%
  const flat = hist.map(m => Number(m.id.slice(1)) % 2
    ? { ...m, goals_home: 2, goals_away: 1 } : { ...m, goals_home: 1, goals_away: 0 });
  assert.strictEqual(trendsPost([fx], flat), null);
});

const odds = (book, at, h, d, a) => ({ id: `${book}${at}`, match_id: 'F', bookmaker: book, fetched_at: at, home_odds: h, draw_odds: d, away_odds: a });
const oddsRows = [
  odds('b1', '2026-10-08T10:00:00Z', 2.5, 3.4, 2.9), odds('b1', '2026-10-09T20:00:00Z', 2.1, 3.5, 3.6),
  odds('b2', '2026-10-08T10:00:00Z', 2.4, 3.3, 3.0), odds('b2', '2026-10-09T20:00:00Z', 2.05, 3.4, 3.7),
  odds('b3', '2026-10-08T10:00:00Z', 2.6, 3.4, 2.8), odds('b3', '2026-10-09T20:00:00Z', 2.2, 3.5, 3.5),
  odds('b4', '2026-10-09T20:00:00Z', 2.3, 3.4, 3.2),    // one row only: this book never moved
];

t('movers use the median across books, open vs now', () => {
  const home = priceMoves(oddsRows).find(m => m.outcome === 'home');
  assert.strictEqual(home.open.toFixed(2), "2.45"); assert.strictEqual(home.now.toFixed(2), "2.15");
  assert.strictEqual(home.books, 4);
});

t('fewer than 3 books is not a market move', () => {
  assert.strictEqual(priceMoves(oddsRows.filter(r => r.bookmaker === 'b1' || r.bookmaker === 'b2')).length, 0);
});

t('movers card never names a book, a fair price or a gap', () => {
  const p = moversPost(oddsRows, [fx]);
  const s = [p.content, ...p.embeds.flatMap(e => [e.title, e.description, e.footer?.text])].join(' ').toLowerCase();
  assert(s.includes('2.95 → 3.55'));  // the away drift is this fixture's biggest move
  assert(s.includes('leeds') || s.includes('hull'));
  for (const w of ['fair', 'gap', 'value', 'b1', 'b2', 'b3', 'edge', 'prime']) assert(!s.includes(w), `movers card mentions "${w}"`);
});

t('digests never read value_signals (they go to channels everyone can see)', () => {
  const src = require('fs').readFileSync(require.resolve('./lib/discordDigest'), 'utf8');
  const io = require('fs').readFileSync(require.resolve('./postToDiscord'), 'utf8');
  assert(!src.includes('value_signals'));
  const digestIo = io.slice(io.indexOf('Daily digests'), io.indexOf('async function run('));
  assert(!digestIo.includes('value_signals'));
});

// Image cards: async, so they run after the sync checks.
(async () => {
  const { trendsCard, moversCard } = require('./lib/discordCards');
  const { trendSections, moverRows } = require('./lib/discordDigest');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const a = await trendsCard(trendSections([fx], hist));
  assert(a.subarray(0, 4).equals(PNG) && a.length > 10000, 'trends card is a real PNG'); n++; console.log(`ok ${n} trends card renders`);
  const b = await moversCard(moverRows(oddsRows, [fx]));
  assert(b.subarray(0, 4).equals(PNG) && b.length > 10000, 'movers card is a real PNG'); n++; console.log(`ok ${n} movers card renders`);
  console.log(`\n${n} passed`);
})().catch(err => { console.error(err); process.exit(1); });
