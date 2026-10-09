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

const FORM_N = 10;         // last N completed matches per team: the site shows L5 and L10
const FORM_MIN = 8;        // fewer than this and the team is not shown

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
  // Per-game hits, OLDEST FIRST, so a strip reads left to right like a form guide.
  const seq = { over25: [], under25: [], btts: [] };
  for (const m of [...mine].reverse()) {
    const g = m.goals_home + m.goals_away;
    seq.over25.push(g >= 3); seq.under25.push(g < 3);
    seq.btts.push(m.goals_home > 0 && m.goals_away > 0);
  }
  for (const m of mine) {
    const t = m.goals_home + m.goals_away;
    goals += t;
    if (t >= 3) over25++; else under25++;
    if (m.goals_home > 0 && m.goals_away > 0) btts++;
  }
  return { n: mine.length, over25, under25, btts, avgGoals: goals / mine.length, seq };
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

/** 🟩 for a game that fitted the pattern, 🟥 for one that did not, oldest first. */
const strip = hits => hits.map(h => (h ? '🟩' : '🟥')).join('');

/**
 * Three lines per fixture: the fixture and kick-off, then one strip per team.
 *   **Ajax v NEC Nijmegen** · 20:00
 *   🟩🟩🟩🟥🟩🟩🟩🟩🟩🟩 `9/10` Ajax
 *   🟩🟩🟩🟩🟩🟥🟩🟩🟩🟩 `9/10` NEC Nijmegen
 */
function trendLines(list, field) {
  return list.map(f => [
    `**${names(f)}** · ${t(f.kickoff_at)}`,
    `${strip(f.h.seq[field])} \`${f.h[field]}/${f.h.n}\` ${f.home_team?.name ?? 'Home'}`,
    `${strip(f.a.seq[field])} \`${f.a[field]}/${f.a.n}\` ${f.away_team?.name ?? 'Away'}`,
  ].join('\n')).join('\n\n');
}

const TREND_SECTIONS = [
  ['over25',  '3+ goals',              COLOUR.PRIME],
  ['btts',    'Both teams scored',     COLOUR.EDGE],
  ['under25', '2 goals or fewer',      COLOUR.LOSS],
];

/**
 * The #hit-rates post: one small card per trend, so each reads on its own.
 * Returns null when nothing clears the bar, so a quiet day posts nothing
 * rather than a list of 50/50s dressed up as trends.
 */
/** The selection both the text card and the image card draw from. */
function trendSections(fixtures, history, { k = 3 } = {}) {
  const forms = fixtureForms(fixtures, history);
  return TREND_SECTIONS
    .map(([field, title, color]) => ({ field, title, color, list: topBy(forms, field, k) }))
    .filter(s => s.list.length);
}

function trendsPost(fixtures, history, opts = {}) {
  const embeds = [];
  for (const { field, title, color, list } of trendSections(fixtures, history, opts)) {
    embeds.push({
      title,
      description: `Last ${FORM_N} games, oldest to newest. 🟩 it happened, 🟥 it did not.\n\n${trendLines(list, field)}`.slice(0, 4096),
      color,
    });
  }
  if (!embeds.length) return null;
  embeds[embeds.length - 1].footer = { text: FOOTER };
  const content = "**Today's trends** · fixtures in the next 24 hours where both teams share a pattern. " +
    `Form describes what happened, not what will. More on ${SITE.replace('https://', '')}/hit-rates`;
  return assertClean({ content, embeds, allowed_mentions: { parse: [] } }, 'trendsPost');
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

/** The selection both the text card and the image card draw from. */
function moverRows(rows, fixtures, { k = 5 } = {}) {
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
  const label = m => {
    const f = fx.get(m.match_id);
    return { ...m, fixture: f, kickoff_at: f.kickoff_at, side: sideName(f, m.outcome),
      vs: m.outcome === 'draw' ? names(f) : `v ${sideName(f, m.outcome === 'home' ? 'away' : 'home')}` };
  };
  return { shortened: shortened.map(label), drifted: drifted.map(label) };
}

/** The #market-pulse card, or null if nothing moved enough. */
function moversPost(rows, fixtures, opts = {}) {
  const { shortened, drifted } = moverRows(rows, fixtures, opts);
  if (!shortened.length && !drifted.length) return null;

  // One line per move, the change first as a chip so the column scans:
  //   `▼ 18%`  **Tianjin Teda** 4.55 → 3.75  ·  v Chengdu · 13:00
  const line = m => {
    const pct = `${m.move > 0 ? '▲' : '▼'} ${Math.abs(m.move * 100).toFixed(0)}%`;
    const price = `${m.open.toFixed(2)} → ${m.now.toFixed(2)}`;
    return `\`${pct}\`  **${m.side}** ${price}  ·  ${m.vs} · ${t(m.kickoff_at)}`;
  };
  const embeds = [];
  if (shortened.length) embeds.push({ title: 'Shortened', description: `Price got smaller\n\n${shortened.map(line).join('\n')}`.slice(0, 4096), color: COLOUR.PRIME });
  if (drifted.length) embeds.push({ title: 'Drifted', description: `Price got bigger\n\n${drifted.map(line).join('\n')}`.slice(0, 4096), color: COLOUR.LOSS });
  embeds[embeds.length - 1].footer = { text: FOOTER };

  const content = `**Market movers** · biggest 1X2 moves for the next 24 hours, typical price across ${MIN_BOOKS}+ bookmakers ` +
    `from open to now. A move shows where the market went, not which side is right.`;
  return assertClean({ content, embeds, allowed_mentions: { parse: [] } }, 'moversPost');
}

module.exports = {
  formOf, fixtureForms, trendSections, trendsPost, priceMoves, moverRows, moversPost, median,
  FORM_N, FORM_MIN, MIN_BOOKS, MIN_MOVE,
};

// ── edge table (weekly, #edge-table) ────────────────────────────────────────
// Built from lib/edgeTable.edgeSummary: settled results against their own
// closing prices. Settled history only, never a pending claim.

const EDGE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayMonth = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${Number(m[3])} ${EDGE_MONTHS[Number(m[2]) - 1]}` : 'the latest round'; };
const signed = (x, dp = 1) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(dp)}`;

function edgeFinding(s) {
  const exp = Math.round(s.expectedByChance);
  const first = `${s.clearNominal} of ${s.ranked} clubs are 2+ standard errors from their closing line; chance alone would put about ${exp} there.`;
  const second = s.bar == null ? ''
    : s.clearBar === 0
      ? ` None clears the ${s.bar.toFixed(1)} bar that allows for testing ${s.ranked} clubs at once.`
      : ` ${s.clearBar} clear${s.clearBar === 1 ? 's' : ''} the ${s.bar.toFixed(1)} bar that allows for testing ${s.ranked} clubs at once.`;
  return first + second;
}

function edgeLine(t, label) {
  return `**${t.team}** (${label(t.div)}) ${t.wins}-${t.draws}-${t.losses} · `
    + `${signed(t.edgePoints)} pts · ${signed(t.profitUnits, 2)}u · z ${signed(t.z, 1)}`;
}

/** Text version of the #edge-table card: alt text, copy check, and the fallback post. */
function edgePost(s, season, label) {
  if (!s || s.ranked < 2) return null;
  const embeds = [
    { title: 'Beating the closing line', description: s.top.map(t => edgeLine(t, label)).join('\n').slice(0, 4096), color: COLOUR.PRIME },
    { title: 'Behind the closing line', description: s.bottom.map(t => edgeLine(t, label)).join('\n').slice(0, 4096), color: COLOUR.LOSS },
    { title: 'How much of this is chance', description: edgeFinding(s), color: COLOUR.RECORD, footer: { text: FOOTER } },
  ];
  const content = `**Edge table · ${season}** · wins against what the closing prices said, with the bookmaker margin taken out. `
    + `Results through ${dayMonth(s.throughDate)}. More on ${SITE.replace('https://', '')}/leagues`;
  return assertClean({ content, embeds, allowed_mentions: { parse: [] } }, 'edgePost');
}

module.exports.edgePost = edgePost;
module.exports.edgeFinding = edgeFinding;
