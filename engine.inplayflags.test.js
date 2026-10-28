'use strict';
// lib/inplayFlags — which tracker flags are new, and what a post may say.

const assert = require('assert');
const { flagKey, postable, worthPosting, newFlags, flagPost, withCard, MAX_FLAGS_PER_MATCH, LATEST_MINUTE } = require('./lib/inplayFlags');
const { teamMark } = require('./lib/discordCards');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };

const flag = (kind, side, extra = {}) => ({ kind, side, tone: 'alert', title: 'Red card', detail: 'Something happened.', ...extra });
const match = (over = {}) => ({
  id: '11111111-1111-1111-1111-111111111111', homeTeam: 'Arsenal', awayTeam: 'Chelsea', league: 'Premier League',
  minute: 34, period: '1H', homeGoals: 0, awayGoals: 1, flags: [], ...over,
});

t('the same flag re-read is the same key; a second red is a new one', () => {
  assert.strictEqual(flagKey(flag('pressure', 'home')), 'pressure:home');
  assert.strictEqual(flagKey(flag('goals-due', null)), 'goals-due:match');
  assert.strictEqual(flagKey(flag('red-card', 'away')), 'red-card:away:1');
  assert.strictEqual(flagKey(flag('red-card', 'away', { title: '2 red cards' })), 'red-card:away:2');
  // "Favourite behind early" becoming "Favourite behind" is not a new event
  assert.strictEqual(flagKey(flag('fav-trailing', 'home', { title: 'Favourite behind early' })),
    flagKey(flag('fav-trailing', 'home', { title: 'Favourite behind' })));
});

t('a finished or late match posts nothing', () => {
  assert(postable(match()));
  assert(postable(match({ period: 'HT', minute: 45 })));
  assert(!postable(match({ period: 'FT' })));
  assert(!postable(match({ minute: LATEST_MINUTE + 1 })));
  assert(!postable({ minute: 10 }));
});

t('only flags the ledger has not seen are new', () => {
  const m = match({ flags: [flag('red-card', 'away'), flag('pressure', 'home')] });
  const posted = new Map([[m.id, new Set(['red-card:away:1'])]]);
  const out = newFlags([m], posted);
  assert.deepStrictEqual(out.map(x => x.key), ['pressure:home']);
});

t('a busy match is capped', () => {
  const kinds = ['red-card', 'fav-trailing', 'pressure', 'goals-due', 'drift'];
  const m = match({ flags: kinds.map(k => flag(k, k === 'goals-due' ? null : 'home')) });
  assert.strictEqual(newFlags([m], new Map()).length, MAX_FLAGS_PER_MATCH);
  const full = new Map([[m.id, new Set(['a', 'b', 'c', 'd'])]]);
  assert.strictEqual(newFlags([m], full).length, 0);
});

t('a post carries the score, the clock and the flag sentence, and links the match', () => {
  const m = match();
  const p = flagPost(m, flag('red-card', 'away', { detail: 'R. James sent off (34\'). Chelsea down to 10 men.' }));
  const e = p.embeds[0];
  assert(e.description.includes('Arsenal 0–1 Chelsea'));
  assert(e.description.includes("34'"));
  assert(e.description.includes('R. James sent off'));
  assert.strictEqual(e.url, `https://maxedge.live/match/${m.id}`);
  assert(e.footer.text.includes('18+'));
  assert(e.footer.text.includes('not tips'));
  assert.deepStrictEqual(p.allowed_mentions, { parse: [] });
});

t('a post never names a price, a stake or a pick', () => {
  const p = flagPost(match(), flag('pressure', 'home', { detail: 'Arsenal: 6 shots on target to 1, still behind at 0–1.' }));
  const e = p.embeds[0];
  // The brand's address (maxedge.live, also in the footer) is not an "edge" claim, so it is removed first.
  const s = `${e.title} ${e.description} ${e.footer.text}`.toLowerCase().replace(/maxedge\.live\S*/g, '');
  for (const w of ['bet now', 'back ', 'stake', 'edge', 'value', 'odds']) assert(!s.includes(w), `post mentions "${w}"`);
});

t('banned words refuse the post rather than soften it', () => {
  assert.throws(() => flagPost(match(), flag('pressure', 'home', { detail: 'A guaranteed goal is coming.' })));
});


t('the card rides as the embed image and the text survives', () => {
  const p = withCard(flagPost(match(), flag('red-card', 'away')), 'flag.png');
  assert.strictEqual(p.embeds[0].image.url, 'attachment://flag.png');
  assert(p.embeds[0].description.includes('Arsenal 0–1 Chelsea'));
  assert.deepStrictEqual(p.allowed_mentions, { parse: [] });
});

t('crests are replaced by a three-letter mark', () => {
  assert.strictEqual(teamMark('Tottenham'), 'TOT');
  assert.strictEqual(teamMark('Manchester United'), 'MU');
  assert.strictEqual(teamMark('Toronto FC'), 'TOR');
  assert.strictEqual(teamMark('CF Montreal'), 'MON');
  assert.strictEqual(teamMark(''), '?');
});

const { xEligible, xFlagText, FRAMES, DEFAULT_LEAGUES } = require('./lib/inplayFlagsX');
const { skeletonOf, mayPost } = require('./lib/xGuard');

t('X takes only alert flags from listed leagues, matched by id', () => {
  const L = new Set(DEFAULT_LEAGUES);
  const m = match();   // Arsenal 0-1 Chelsea: the away side leads
  assert(xEligible(flag('red-card', 'away'), '39', L, m));
  assert(xEligible(flag('fav-trailing', 'home'), 39, L, m));
  assert(!xEligible(flag('pressure', 'home'), '39', L, m));
  assert(!xEligible(flag('goals-due', null), '39', L, m));
  assert(!xEligible(flag('red-card', 'away'), '235', L, m));   // Russian "Premier League"
  assert(!xEligible(flag('red-card', 'away'), '71', L, m));    // Brazilian "Serie A"
  assert(!xEligible(flag('red-card', 'away'), null, L, m));
});

t('X takes a red card only when the side that got it is leading', () => {
  const L = new Set(DEFAULT_LEAGUES);
  assert(xEligible(flag('red-card', 'home'), '39', L, match({ homeGoals: 2, awayGoals: 1 })));
  assert(!xEligible(flag('red-card', 'home'), '39', L, match({ homeGoals: 1, awayGoals: 1 })));   // level
  assert(!xEligible(flag('red-card', 'home'), '39', L, match({ homeGoals: 0, awayGoals: 1 })));   // behind
  assert(!xEligible(flag('red-card', 'away'), '39', L));                                          // no match row: refused
  assert(!xEligible(flag('red-card', null), '39', L, match()));
  // favourite-behind is unaffected by the scoreline rule
  assert(xEligible(flag('fav-trailing', 'home'), '39', L, match({ homeGoals: 0, awayGoals: 1 })));
});

t('X text: facts, footer, no link, and every frame a different shape', () => {
  const m = match({ minute: 78, homeGoals: 1, awayGoals: 0, homeTeam: 'Manchester United', awayTeam: 'Tottenham' });
  const f = flag('red-card', 'away', { detail: "Rodrigo Bentancur sent off (78'). Tottenham down to 10 men." });
  const shapes = new Set();
  for (let i = 0; i < FRAMES.length; i++) {
    const s = xFlagText(m, f, i);
    assert(s.endsWith('18+ | GamCare 0808 8020 133 | Live match facts, not advice'));
    assert(s.includes('Manchester United 1-0 Tottenham'));
    assert(!/https?:|maxedge\.live/i.test(s));
    assert(s.length <= 280, `frame ${i} is ${s.length} chars`);
    shapes.add(skeletonOf(s));
  }
  assert.strictEqual(shapes.size, FRAMES.length);
  // More frames than the guard's window, or the channel deadlocks.
  assert(FRAMES.length > 4);
});

t('the guard always finds a free frame after four posts', () => {
  const m = match(); const f = flag('fav-trailing', 'home', { detail: 'Arsenal were 60% to win before kick-off and trail 0-1.' });
  const recent = [0, 1, 2, 3].map(i => skeletonOf(xFlagText(m, f, i)));
  const env = { X_POSTING_ENABLED: '1', X_DAILY_CAP: '6' };
  const free = FRAMES.map((_, i) => mayPost({ text: xFlagText(m, f, i), recentSkeletons: recent, postedToday: 4, env }).ok);
  assert(free.filter(Boolean).length >= 2);
});

t('pressure posts up to 60 minutes, not after', () => {
  const f = flag('pressure', 'home');
  assert(worthPosting(match({ minute: 34 }), f));
  assert(worthPosting(match({ period: 'HT', minute: 45 }), f));
  assert(worthPosting(match({ period: '2H', minute: 60 }), f));
  assert(!worthPosting(match({ period: '2H', minute: 61 }), f));
  assert(!worthPosting(match({ period: 'ET', minute: 95 }), f));
});

t('favourite behind posts in the first half and at half-time only', () => {
  const f = flag('fav-trailing', 'home');
  assert(worthPosting(match({ period: '1H', minute: 12 }), f));
  assert(worthPosting(match({ period: 'HT', minute: 45 }), f));
  assert(!worthPosting(match({ period: '2H', minute: 47 }), f));
  assert(worthPosting(match({ period: null, minute: 40 }), f));
  assert(!worthPosting(match({ period: null, minute: 50 }), f));
});

t('a red card skips only when the 11 men were long odds before kick-off', () => {
  const f = flag('red-card', 'away');                       // away down to 10, home has 11
  assert(!worthPosting(match({ pre: { home: 0.20, draw: 0.25, away: 0.55 } }), f));
  assert(worthPosting(match({ pre: { home: 0.35, draw: 0.30, away: 0.35 } }), f));
  assert(worthPosting(match({ pre: { home: 0.70, draw: 0.20, away: 0.10 } }), f));
  assert(worthPosting(match({ pre: null }), f));              // no price: the fact still posts
});

t('goals expected and drift are not filtered', () => {
  assert(worthPosting(match({ period: '2H', minute: 70 }), flag('goals-due', null)));
  assert(worthPosting(match({ period: '2H', minute: 70 }), flag('drift', 'home')));
});

t('a filtered flag is not posted and does not use up the match cap', () => {
  const m = match({ period: '2H', minute: 70, flags: [flag('pressure', 'home'), flag('fav-trailing', 'home'), flag('goals-due', null)] });
  assert.deepStrictEqual(newFlags([m], new Map()).map(x => x.key), ['goals-due:match']);
});

console.log(`\n${n} passed`);
