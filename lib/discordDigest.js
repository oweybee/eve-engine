'use strict';

/**
 * lib/discordDigest — the two daily Discord digests that are NOT signals.
 *
 *   trends   #hit-rates      recent goals form for today's fixtures
 *   movers   #market-pulse   the biggest 1X2 price moves since prices opened
 *
 * ── WHY THESE TWO, AND WHY THEY NEVER LEAK THE BOARD ───────────────────────
 *
 * #signals is Plus only (owner ruling, 9 Oct). These digests go to channels
 * every Verified 18+ member can read, so they are built from data that says
 * nothing about where a selection sits against its fair price:
 *
 *   trends  uses settled scores only. No prices at all.
 *   movers  uses the MEDIAN price across books, open vs now. A median says
 *           where the market moved; it never names the best book, never
 *           prints a fair price or a gap, and never marks a side as value.
 *
 * Neither reads the signals table. A test pins that.
 *
 * Pure functions, no I/O. Copy goes through discordCompose's assertClean.
 */

const { assertClean, FOOTER, COLOUR } = require('./discordCompose');

const SITE = 'https://maxedge.live';

// ── trends ──────────────────────────────────────────────────────────────────

const FORM_N = 8;          // last N completed matches per team
const FORM_MIN = 6;        // fewer than this and the team is not shown

/**
 * Goals form for one team from its completed matches (any venue), newest
 * first. Returns null below FORM_MIN, so a newly promoted side with three
 * games never headlines a list on a 3/3.
 */
function formOf(teamId, matches, n = FORM_N) {
  const mine = matches
    .filter(m => (m.home_team_id === teamId || m.away_team_id === teamId)
      && m.goals_home != null && m.goals_away != null)
    .sort((a, b) => new Date(b.kickoff_at) - new Date(a.kickoff_at))
    .slice(0, n);
  if (mine.length < FORM_MIN) return null;
  let over25 = 0, btts = 0, goals = 0, under25 = 0;
  for (const m of mine) {
    const t = m.goals_home + m.goals_away;
    goals += t;
    if (t >= 3) over25++; else under25++;
    if (m.goals_home > 0 && m.goals_away > 0) btts++;
  }
  return { n: mine.length, over25, under25, btts, avgGoals: goals / mine.length };
}

/** Each fixture with both teams' form, or dropped if either side is thin. */
function fixtureForms(fixtures, history) {
  return fixtures.map(f => {
    const h = formOf(f.home_team_id, history);
    const a = formOf(f.away_team_id, history);
    return h && a ? { ...f, h, a } : null;
  }).filter(Boolean);
}

const rate = (x, f) => x[f] / x.n;

function topBy(forms, field, k) {
  return forms
    .map(f => ({ f, score: (rate(f.h, field) + rate(f.a, field)) / 2 }))
    .filter(x => x.score >= 0.7)
    .sort((x, y) => y.score - x.score || new Date(x.f.kickoff_at) - new Date(y.f.kickoff_at))
    .slice(0, k)
    .map(x => x.f);
}

const names = f => `${f.home_team?.name ?? 'Home'} v ${f.away_team?.name ?? 'Away'}`;
const t = iso => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:t>`;

function trendLines(list, field, label) {
  return list.map(f =>
    `**${names(f)}** ${t(f.kickoff_at)}\n` +
    `${f.home_team?.name ?? 'Home'} ${f.h[field]}/${f.h.n} · ${f.away_team?.name ?? 'Away'} ${f.a[field]}/${f.a.n} ${label}`
  ).join('\n');
}

/**
 * The #hit-rates card. Returns null when nothing clears the bar, so a quiet
 * day posts nothing rather than a list of 50/50s dressed up as trends.
 */
function trendsPost(fixtures, history, { k = 5 } = {}) {
  const forms = fixtureForms(fixtures, history);
  const goals = topBy(forms, 'over25', k);
  const btts = topBy(forms, 'btts', k);
  const tight = topBy(forms, 'under25', Math.min(k, 3));
  if (!goals.length && !btts.length && !tight.length) return null;

  const fields = [];
  if (goals.length) fields.push({ name: 'Goals: 3+ in recent games', value: trendLines(goals, 'over25', 'had 3+ goals').slice(0, 1024) });
  if (btts.length) fields.push({ name: 'Both teams scoring', value: trendLines(btts, 'btts', 'had both teams score').slice(0, 1024) });
  if (tight.length) fields.push({ name: 'Tight games: 2 goals or fewer', value: trendLines(tight, 'under25', 'had 2 goals or fewer').slice(0, 1024) });

  const payload = {
    embeds: [{
      title: "Today's trends",
      url: `${SITE}/hit-rates`,
      description: `Each team's last ${FORM_N} games, home and away, for fixtures in the next 24 hours. ` +
        'Form describes what happened, not what will. Times show in your local time.',
      color: COLOUR.RECORD,
      fields,
      footer: { text: FOOTER },
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'trendsPost');
}

// ── movers ──────────────────────────────────────────────────────────────────

const MIN_BOOKS = 3;       // a median of two books is just two books
const MIN_MOVE = 0.08;     // 8% on the price
const MAX_PRICE = 8;       // long prices move a lot and mean little

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const OUTCOMES = [['home', 'home_odds'], ['draw', 'draw_odds'], ['away', 'away_odds']];

/**
 * Open and current median price per (match, outcome) from the `odds` change
 * log. A book's open is its earliest row, its now is its latest; only books
 * with both count, and only fixtures with MIN_BOOKS of them.
 */
function priceMoves(rows) {
  const byKey = new Map();       // match|book -> {first, last}
  for (const r of rows) {
    const k = `${r.match_id}|${r.bookmaker}`;
    const e = byKey.get(k);
    if (!e) { byKey.set(k, { first: r, last: r }); continue; }
    if (new Date(r.fetched_at) < new Date(e.first.fetched_at)) e.first = r;
    if (new Date(r.fetched_at) >= new Date(e.last.fetched_at)) e.last = r;
  }
  const perMatch = new Map();    // match -> outcome -> {open:[], now:[]}
  for (const [k, { first, last }] of byKey) {
    const match = k.split('|')[0];
    const m = perMatch.get(match) ?? {};
    for (const [o, col] of OUTCOMES) {
      const a = Number(first[col]), b = Number(last[col]);
      if (!(a > 1) || !(b > 1)) continue;
      (m[o] ??= { open: [], now: [] });
      m[o].open.push(a); m[o].now.push(b);
    }
    perMatch.set(match, m);
  }
  const out = [];
  for (const [match_id, m] of perMatch) {
    for (const [o] of OUTCOMES) {
      const x = m[o];
      if (!x || x.open.length < MIN_BOOKS) continue;
      const open = median(x.open), now = median(x.now);
      out.push({ match_id, outcome: o, open, now, move: now / open - 1, books: x.open.length });
    }
  }
  return out;
}

function sideName(fixture, outcome) {
  if (outcome === 'home') return fixture.home_team?.name ?? 'Home';
  if (outcome === 'away') return fixture.away_team?.name ?? 'Away';
  return 'Draw';
}

/** The #market-pulse card, or null if nothing moved enough. */
function moversPost(rows, fixtures, { k = 5 } = {}) {
  const fx = new Map(fixtures.map(f => [f.id, f]));
  const moves = priceMoves(rows).filter(m =>
    fx.has(m.match_id) && Math.abs(m.move) >= MIN_MOVE && m.open <= MAX_PRICE && m.now <= MAX_PRICE);
  // One line per fixture: its biggest single move, so one match cannot fill the card.
  const best = new Map();
  for (const m of moves) {
    const cur = best.get(m.match_id);
    if (!cur || Math.abs(m.move) > Math.abs(cur.move)) best.set(m.match_id, m);
  }
  const all = [...best.values()];
  const shortened = all.filter(m => m.move < 0).sort((a, b) => a.move - b.move).slice(0, k);
  const drifted = all.filter(m => m.move > 0).sort((a, b) => b.move - a.move).slice(0, k);
  if (!shortened.length && !drifted.length) return null;

  const line = m => {
    const f = fx.get(m.match_id);
    return `**${sideName(f, m.outcome)}** (${names(f)}) ${t(f.kickoff_at)}\n` +
      `${m.open.toFixed(2)} → ${m.now.toFixed(2)} (${m.move > 0 ? '+' : ''}${(m.move * 100).toFixed(0)}%)`;
  };
  const fields = [];
  if (shortened.length) fields.push({ name: 'Shortened: money coming in', value: shortened.map(line).join('\n').slice(0, 1024) });
  if (drifted.length) fields.push({ name: 'Drifted: price getting bigger', value: drifted.map(line).join('\n').slice(0, 1024) });

  const payload = {
    embeds: [{
      title: 'Market movers',
      url: `${SITE}/market-pulse`,
      description: `Biggest 1X2 moves for fixtures in the next 24 hours. Typical price across ${MIN_BOOKS}+ bookmakers, ` +
        'when prices opened vs now. A move shows where the market went, not which side is right.',
      color: COLOUR.EDGE,
      fields,
      footer: { text: FOOTER },
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'moversPost');
}

module.exports = {
  formOf, fixtureForms, trendsPost, priceMoves, moversPost, median,
  FORM_N, FORM_MIN, MIN_BOOKS, MIN_MOVE,
};
