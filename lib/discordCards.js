'use strict';

/**
 * lib/discordCards — the trends and movers digests drawn as PNG cards.
 *
 * Discord cannot colour text in an embed, and the phone app ignores coloured
 * code blocks. An image is the only way to get the brand palette onto every
 * device, and the same PNG can go to X unchanged.
 *
 * Satori lays the card out (flexbox), resvg turns the SVG into a PNG. Both are
 * pure JS / prebuilt binaries, so the GitHub runner needs nothing installed.
 *
 * Content comes from lib/discordDigest (the same selection the text cards
 * use), so the image can never show something the text version would not.
 * Palette and type are the brand sheet of 7 Oct: Onest, #0D1116 ground,
 * #99EC72 brand green, #FFF478 for a drifting figure, #FF3C46 as a fill.
 */

const fs = require('fs');
const path = require('path');

const C = {
  page: '#0D1116', card: '#191C22', tile: '#24282E', border: '#23272E',
  ink: '#FFFFFF', mid: '#BCC0C5', low: '#9DA1A6', dim: '#85888E',
  green: '#99EC72', yellow: '#FFF478', red: '#FF3C46',
};
const W = 1200;
const FOOT = '18+  ·  Information only, we never place bets';

let fontsCache = null;
function fonts() {
  if (fontsCache) return fontsCache;
  const dir = path.dirname(require.resolve('@fontsource/onest/package.json'));
  // The two subsets go in under different names so Satori falls back from one
  // to the other per glyph (ğ, ţ, ő live in latin-ext; same-name entries clash).
  const f = (subset, weight) => ({
    name: subset === 'latin' ? 'Onest' : 'OnestExt', weight, style: 'normal',
    data: fs.readFileSync(path.join(dir, 'files', `onest-${subset}-${weight}-normal.woff`)),
  });
  fontsCache = [400, 600, 700].flatMap(w => [f('latin', w), f('latin-ext', w)]);
  return fontsCache;
}

// Tiny element helper so the layout reads like markup.
const h = (type, style, ...children) => ({
  type, props: { style: { display: 'flex', ...style }, children: children.flat().filter(c => c != null && c !== false) },
});
const text = (s, style) => h('div', style, String(s));

const ukTime = iso => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));
const ukDay = (d = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short',
}).format(d);

function header(label, sub) {
  return h('div', { justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 },
    h('div', { flexDirection: 'column' },
      text(label, { color: C.green, fontSize: 22, fontWeight: 700, letterSpacing: 3 }),
      text(sub, { color: C.mid, fontSize: 22, marginTop: 8 })),
    h('div', { flexDirection: 'column', alignItems: 'flex-end', lineHeight: 0.95 },
      text('MAX', { color: C.ink, fontSize: 30, fontWeight: 700, letterSpacing: 2 }),
      text('EDGE', { color: C.green, fontSize: 30, fontWeight: 700, letterSpacing: 2 })));
}

function footer() {
  return h('div', { justifyContent: 'space-between', marginTop: 28, color: C.dim, fontSize: 18 },
    text(FOOT, {}), text('maxedge.live', { color: C.low, fontWeight: 600 }));
}

async function render(tree, height, width = W) {
  const { default: satori } = await import('satori');
  const { Resvg } = require('@resvg/resvg-js');
  const svg = await satori(tree, { width, height, fonts: fonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

// ── trends ──────────────────────────────────────────────────────────────────

// Landscape on purpose: Discord shrinks a tall image to a thumbnail on
// desktop, so the trends sit side by side in columns, not stacked.
const TW = 1800;

function squares(hits) {
  return h('div', { gap: 5 }, hits.map(hit =>
    h('div', { width: 24, height: 24, borderRadius: 5, backgroundColor: hit ? C.green : C.red })));
}

function teamRow(name, form, field) {
  return h('div', { flexDirection: 'column', marginTop: 10 },
    text(name, { color: C.mid, fontSize: 20, marginBottom: 6 }),
    h('div', { alignItems: 'center', gap: 14 },
      squares(form.seq[field]),
      text(`${form[field]}/${form.n}`, { color: C.ink, fontSize: 22, fontWeight: 700 })));
}

function trendColumn(title, field, list) {
  return h('div', { flexDirection: 'column', flex: 1, backgroundColor: C.card, borderRadius: 16, padding: '24px 28px', border: `1px solid ${C.border}` },
    text(title, { color: C.green, fontSize: 28, fontWeight: 700, marginBottom: 4 }),
    list.map((f, i) => h('div', { flexDirection: 'column', marginTop: 18, paddingTop: i ? 18 : 0, borderTop: i ? `1px solid ${C.border}` : 'none' },
      h('div', { justifyContent: 'space-between', alignItems: 'baseline' },
        text(`${f.home_team?.name ?? 'Home'} v ${f.away_team?.name ?? 'Away'}`, { color: C.ink, fontSize: 22, fontWeight: 600, maxWidth: 380 }),
        text(`${ukTime(f.kickoff_at)}`, { color: C.low, fontSize: 20 })),
      teamRow(f.home_team?.name ?? 'Home', f.h, field),
      teamRow(f.away_team?.name ?? 'Away', f.a, field))));
}

/** sections: [{ title, field, list }] from discordDigest.trendSections */
async function trendsCard(sections, { now = new Date() } = {}) {
  const most = Math.max(...sections.map(s => s.list.length));
  const height = 330 + most * 200;
  const tree = h('div', { flexDirection: 'column', width: TW, height, backgroundColor: C.page, padding: 48, fontFamily: 'Onest, OnestExt' },
    header("TODAY'S TRENDS", `${ukDay(now)}  ·  each team's last 10 games, oldest to newest  ·  kick-offs UK time`),
    h('div', { gap: 20, alignItems: 'stretch', flexGrow: 1 }, sections.map(s => trendColumn(s.title, s.field, s.list))),
    footer());
  return render(tree, height, TW);
}


// ── player hit rates ────────────────────────────────────────────────────────

function playerRow(p, i) {
  return h('div', { flexDirection: 'column', marginTop: 16, paddingTop: i ? 16 : 0, borderTop: i ? `1px solid ${C.border}` : 'none' },
    h('div', { justifyContent: 'space-between', alignItems: 'baseline' },
      text(p.name, { color: C.ink, fontSize: 23, fontWeight: 700, maxWidth: 360 }),
      text(ukTime(p.kickoff_at), { color: C.low, fontSize: 20 })),
    text(`${p.team} v ${p.opponent}`, { color: C.mid, fontSize: 19, marginTop: 4, marginBottom: 8, maxWidth: 460 }),
    h('div', { alignItems: 'center', gap: 14 },
      squares(p.run),
      text(`${p.hits}/${p.games}`, { color: C.ink, fontSize: 22, fontWeight: 700 })));
}

const PCOL = Math.floor((TW - 96 - 40) / 3);   // three to a row, fixed so a short last row lines up

function playerColumn(s) {
  return h('div', { flexDirection: 'column', width: PCOL, backgroundColor: C.card, borderRadius: 16, padding: '24px 28px', border: `1px solid ${C.border}` },
    text(s.title, { color: C.green, fontSize: 28, fontWeight: 700, marginBottom: 4 }),
    s.list.map(playerRow));
}

/** sections: [{ title, list }] from discordDigest.playerSections. Three columns a row. */
async function playersCard(sections, { now = new Date() } = {}) {
  const rows = [];
  for (let i = 0; i < sections.length; i += 3) rows.push(sections.slice(i, i + 3));
  const heights = rows.map(r => 84 + Math.max(...r.map(s => s.list.length)) * 128);
  const height = 260 + heights.reduce((a, b) => a + b, 0) + (rows.length - 1) * 20;
  const tree = h('div', { flexDirection: 'column', width: TW, height, backgroundColor: C.page, padding: 48, fontFamily: 'Onest, OnestExt' },
    header('PLAYER HIT RATES', `${ukDay(now)}  ·  each player's last 10 games played, oldest to newest  ·  kick-offs UK time`),
    h('div', { flexDirection: 'column', gap: 20, flexGrow: 1 },
      rows.map(r => h('div', { gap: 20, alignItems: 'stretch' },
        r.map(playerColumn)))),
    footer());
  return render(tree, height, TW);
}

// ── movers ──────────────────────────────────────────────────────────────────

const svgIcon = (d, fill, size) => ({
  type: 'svg', props: { width: size, height: size, viewBox: '0 0 24 24',
    children: [{ type: 'path', props: { d, fill } }] },
});
const tri = (up, fill) => svgIcon(up ? 'M12 4 L22 20 L2 20 Z' : 'M2 4 L22 4 L12 20 Z', fill, 16);
const arrow = fill => svgIcon('M2 11 H17 L12 6 L13.5 4.5 L21 12 L13.5 19.5 L12 18 L17 13 H2 Z', fill, 24);

function moverRow(m, i) {
  const up = m.move > 0;
  const pct = `${Math.abs(m.move * 100).toFixed(0)}%`;
  return h('div', { alignItems: 'center', gap: 20, marginTop: i ? 16 : 10 },
    h('div', { width: 118, justifyContent: 'center', alignItems: 'center', gap: 8, padding: '6px 0', borderRadius: 999,
      backgroundColor: up ? C.yellow : C.ink },
      tri(up, C.page), text(pct, { fontSize: 22, fontWeight: 700, color: C.page })),
    h('div', { flexDirection: 'column', flexGrow: 1 },
      text(m.side, { color: C.ink, fontSize: 26, fontWeight: 600 }),
      text(`${m.vs}  ·  ${ukTime(m.kickoff_at)} UK`, { color: C.low, fontSize: 20, marginTop: 2 })),
    h('div', { alignItems: 'baseline', gap: 12 },
      text(m.open.toFixed(2), { color: C.dim, fontSize: 24 }),
      arrow(C.dim),
      text(m.now.toFixed(2), { color: C.ink, fontSize: 30, fontWeight: 700 })));
}

function moverSection(title, sub, list) {
  return h('div', { flexDirection: 'column', backgroundColor: C.card, borderRadius: 16, padding: '24px 28px', marginTop: 18, border: `1px solid ${C.border}` },
    h('div', { alignItems: 'baseline', gap: 14 },
      text(title, { color: C.ink, fontSize: 28, fontWeight: 700 }),
      text(sub, { color: C.low, fontSize: 20 })),
    list.map(moverRow));
}

/** groups: { shortened: [...], drifted: [...] } rows from discordDigest.moverRows */
async function moversCard({ shortened, drifted }, { now = new Date() } = {}) {
  const rows = shortened.length + drifted.length;
  const sections = (shortened.length ? 1 : 0) + (drifted.length ? 1 : 0);
  const height = 220 + sections * 90 + rows * 86;
  const tree = h('div', { flexDirection: 'column', width: W, height, backgroundColor: C.page, padding: 48, fontFamily: 'Onest, OnestExt' },
    header('MARKET MOVERS', `${ukDay(now)}  ·  typical price across 3+ bookmakers, open to now`),
    shortened.length ? moverSection('Shortened', 'price got smaller', shortened) : null,
    drifted.length ? moverSection('Drifted', 'price got bigger', drifted) : null,
    h('div', { flexGrow: 1 }),
    footer());
  return render(tree, height);
}

// ── edge table ──────────────────────────────────────────────────────────────

const EDGE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayMonth = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${Number(m[3])} ${EDGE_MONTHS[Number(m[2]) - 1]}` : 'the latest round'; };
const sgn = (x, dp = 1) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(dp)}`;

function edgeRow(t, label, i) {
  const pos = t.edgePoints >= 0;
  return h('div', { alignItems: 'center', gap: 18, marginTop: i ? 14 : 10, paddingTop: i ? 14 : 0,
    borderTop: i ? `1px solid ${C.border}` : 'none' },
    h('div', { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
      text(t.team, { color: C.ink, fontSize: 26, fontWeight: 600 }),
      text(`${label(t.div)}  ·  ${t.wins}-${t.draws}-${t.losses}  ·  ${t.priced} priced`, { color: C.low, fontSize: 19, marginTop: 2 })),
    h('div', { flexDirection: 'column', alignItems: 'flex-end', width: 150 },
      text(`${sgn(t.edgePoints)} pts`, { color: pos ? C.green : C.red, fontSize: 28, fontWeight: 700 }),
      text('wins vs fair line', { color: C.dim, fontSize: 16 })),
    h('div', { flexDirection: 'column', alignItems: 'flex-end', width: 130 },
      text(`${sgn(t.profitUnits, 2)}u`, { color: C.ink, fontSize: 24, fontWeight: 600 }),
      text('at the close', { color: C.dim, fontSize: 16 })),
    h('div', { flexDirection: 'column', alignItems: 'flex-end', width: 90 },
      text(`z ${sgn(t.z)}`, { color: Math.abs(t.z) >= 2 ? C.ink : C.mid, fontSize: 22, fontWeight: Math.abs(t.z) >= 2 ? 700 : 400 }),
      text('std errors', { color: C.dim, fontSize: 16 })));
}

function edgeColumn(title, list, label) {
  return h('div', { flexDirection: 'column', flex: 1, backgroundColor: C.card, borderRadius: 16, padding: '24px 28px', border: `1px solid ${C.border}` },
    text(title, { color: C.green, fontSize: 28, fontWeight: 700, marginBottom: 4 }),
    list.map((t, i) => edgeRow(t, label, i)));
}

/** s from lib/edgeTable.edgeSummary; finding is the sentence edgeFinding() wrote. */
async function edgeCard(s, { season, label, finding, now = new Date() }) {
  const most = Math.max(s.top.length, s.bottom.length);
  const height = 400 + most * 92;
  const tree = h('div', { flexDirection: 'column', width: TW, height, backgroundColor: C.page, padding: 48, fontFamily: 'Onest, OnestExt' },
    header('EDGE TABLE', `${season}  ·  results through ${dayMonth(s.throughDate)}  ·  closing prices, margin taken out  ·  ${s.ranked} clubs ranked`),
    h('div', { gap: 20, alignItems: 'stretch' },
      edgeColumn('Beating the closing line', s.top, label),
      edgeColumn('Behind the closing line', s.bottom, label)),
    h('div', { marginTop: 20, backgroundColor: C.tile, borderRadius: 12, padding: '18px 24px' },
      text(finding, { color: C.mid, fontSize: 21 })),
    h('div', { flexGrow: 1 }),
    footer());
  return render(tree, height, TW);
}

// ── in-play flag ────────────────────────────────────────────────────────────
//
// Redrawn 23 Oct 2026 (owner) in maxedge.live's own look, the same kit as the
// videos: green header bar with the black MAXEDGE wordmark, flat surface
// cards, pill chips, and club badges as patterned discs in kit colours.
// Square on purpose: 1080x1080 shows uncropped in a Discord channel, an X
// timeline and an Instagram feed, so one PNG serves every channel.
const SQ = 1080;

/** Three-letter mark. Kept for callers and tests; the card itself draws a badge disc. */
function teamMark(name) {
  const words = String(name ?? '').replace(/[^A-Za-zÀ-ž0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !/^(FC|AFC|CF|SC|AC|FK|SK|CD|SV|VfB|VfL|1\.)$/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

// The site wordmark (same paths as social/video-kit/site_kit.py WORDMARK).
const WORDMARK_PATHS = '<g transform="translate(-7.65625,0)"><g>'
  + '<path d="M7.65625 60V0H18.828125L55.1171875 48.9453125L90.859375 0H102.03125V60H94.53125V6.796875L58.7109375 56.0546875H51.9140625L15.15625 6.796875V60Z"/>'
  + '<path transform="translate(103.53125,0)" d="M2.5 60 37.5 0H47.5L82.5 60H73.75L66.25 46.25H18.75L11.25 60ZM22.5 40H62.5L42.5 5Z"/>'
  + '<path transform="translate(187.53125,0)" d="M2.5 60 36.6015625 28.359375 5 0H15.625L41.796875 23.515625L67.1484375 0H77.7734375L47.2265625 28.359375L82.5 60H71.875L41.9921875 33.203125L13.125 60Z"/></g>'
  + '<g fill-rule="evenodd" transform="translate(264.18376,0)"><path d="M7.000 0H56V13H13V23.5H50V36.5H13V47H56V60H11.838L0 49.381V6.499Z"/>'
  + '<path transform="translate(64,0)" d="M0 0H44Q64 0 64 20V40Q64 60 44 60H0Z M13 13V47H42Q51 47 51 38V22Q51 13 42 13Z"/>'
  + '<path transform="translate(136,0)" d="M20 0H64V13H22Q13 13 13 22V38Q13 47 22 47H51V36H36V24H64V60H20Q0 60 0 40V20Q0 0 20 0Z"/>'
  + '<path transform="translate(208,0)" d="M0 0H49.000L56 6.499V13H13V23.5H50V36.5H13V47H56V49.381L44.162 60H0Z"/></g></g>';
const svgUri = s => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const wordmark = (height, fill = '#0A0D11') => ({ type: 'img', props: {
  src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520.53 60" fill="${fill}">${WORDMARK_PATHS}</svg>`),
  width: Math.round(height * 520.53 / 60), height } });

// Club badges: patterned discs in kit colours, never the crest, never initials
// (owner rule, 22 Oct 2026). Same table as social/video-kit/site_kit.py KITS.
const KITS = {
  'Arsenal': ['sleeves', '#DB0007', '#FFFFFF'], 'Chelsea': ['solid', '#034694', '#FFFFFF'], 'Tottenham': ['solid', '#FFFFFF', '#132257'],
  'Manchester City': ['solid', '#6CABDD', '#FFFFFF'], 'Manchester United': ['solid', '#DA291C', '#111111'], 'Liverpool': ['solid', '#C8102E', '#FFFFFF'],
  'Brighton': ['stripes', '#0057B8', '#FFFFFF'], 'Newcastle': ['stripes', '#111111', '#FFFFFF'], 'Aston Villa': ['sleeves', '#670E36', '#95BFE5'],
  'Brentford': ['stripes', '#E30613', '#FFFFFF'], 'Everton': ['solid', '#003399', '#FFFFFF'], 'Crystal Palace': ['stripes', '#C4122E', '#1B458F'],
  'Bournemouth': ['stripes', '#DA291C', '#111111'], 'Fulham': ['solid', '#FFFFFF', '#111111'], 'Nottingham Forest': ['solid', '#DD0000', '#FFFFFF'],
  'Leeds': ['solid', '#FFFFFF', '#1D428A'], 'Sunderland': ['stripes', '#EB172B', '#FFFFFF'], 'Coventry': ['solid', '#77B5E6', '#FFFFFF'],
  'Hull City': ['stripes', '#F5A12D', '#111111'], 'Ipswich': ['solid', '#0E63AD', '#FFFFFF'], 'West Ham': ['sleeves', '#7A263A', '#1BB1E7'],
  'Wolves': ['solid', '#FDB913', '#231F20'], 'Barcelona': ['stripes', '#A50044', '#004D98'], 'Real Madrid': ['solid', '#FFFFFF', '#FEBE10'],
  'Atletico Madrid': ['stripes', '#CB3524', '#FFFFFF'], 'Bayern München': ['solid', '#DC052D', '#FFFFFF'], 'Borussia Dortmund': ['solid', '#FDE100', '#111111'],
  'Bayer Leverkusen': ['solid', '#E32221', '#111111'], 'Inter': ['stripes', '#0068A8', '#111111'], 'AC Milan': ['wide', '#FB090B', '#111111'],
  'Juventus': ['stripes', '#111111', '#FFFFFF'], 'Napoli': ['solid', '#12A0D7', '#FFFFFF'], 'AS Roma': ['solid', '#8E1F2F', '#F0BC42'],
  'Lazio': ['solid', '#87D8F7', '#FFFFFF'], 'Paris Saint Germain': ['centre', '#004170', '#DA291C'], 'Celtic': ['hoops', '#018749', '#FFFFFF'],
  'Rangers': ['solid', '#1B458F', '#FFFFFF'], 'Heart Of Midlothian': ['solid', '#8C1D40', '#FFFFFF'], 'Aberdeen': ['solid', '#C8102E', '#FFFFFF'],
  'SC Freiburg': ['solid', '#E2001A', '#111111'], 'FC Augsburg': ['halves', '#BA3733', '#46714D'], 'Borussia Mönchengladbach': ['solid', '#FFFFFF', '#111111'],
  'RB Leipzig': ['solid', '#FFFFFF', '#DD0741'], 'Eintracht Frankfurt': ['solid', '#111111', '#E1000F'], 'VfB Stuttgart': ['solid', '#FFFFFF', '#E32219'],
  'Benfica': ['solid', '#E83030', '#FFFFFF'], 'FC Porto': ['stripes', '#00428C', '#FFFFFF'], 'Sporting CP': ['hoops', '#008057', '#FFFFFF'],
  'Ajax': ['centre', '#FFFFFF', '#D2122E'], 'Feyenoord': ['halves', '#E3000B', '#FFFFFF'], 'PSV Eindhoven': ['stripes', '#ED1C24', '#FFFFFF'],
  'Marseille': ['solid', '#FFFFFF', '#2FAEE0'], 'Lyon': ['solid', '#FFFFFF', '#DA0812'], 'Monaco': ['halves', '#E7001E', '#FFFFFF'],
  'Galatasaray': ['halves', '#A90432', '#FDB912'], 'Fenerbahçe': ['stripes', '#163962', '#FFED00'], 'Beşiktaş': ['stripes', '#111111', '#FFFFFF'],
  'Real Betis': ['stripes', '#00954C', '#FFFFFF'], 'Sevilla': ['solid', '#FFFFFF', '#D81E05'], 'Villarreal': ['solid', '#FFE667', '#005187'],
  'Athletic Club': ['stripes', '#EE2523', '#FFFFFF'], '1899 Hoffenheim': ['solid', '#1961B5', '#FFFFFF'], 'Werder Bremen': ['solid', '#1D9053', '#FFFFFF'],
  'FSV Mainz 05': ['solid', '#C3141E', '#FFFFFF'], 'Union Berlin': ['solid', '#EB1923', '#FFFFFF'], 'VfL Wolfsburg': ['solid', '#65B32E', '#FFFFFF'],
  '1. FC Köln': ['solid', '#FFFFFF', '#ED1C24'], 'Hamburger SV': ['solid', '#FFFFFF', '#0A3F86'], 'FC Schalke 04': ['solid', '#004D9D', '#FFFFFF'],
  'Lens': ['halves', '#FFE100', '#E1001A'], 'Lille': ['solid', '#E01E13', '#20325F'], 'Nice': ['stripes', '#C8102E', '#111111'],
  'Rennes': ['solid', '#E13327', '#111111'], 'Strasbourg': ['solid', '#009FE3', '#FFFFFF'], 'Trabzonspor': ['stripes', '#7A1E30', '#4AB7E8'],
  'Real Sociedad': ['stripes', '#0067B1', '#FFFFFF'], 'Valencia': ['solid', '#FFFFFF', '#111111'],
};
const KIT_ALIAS = {
  'bayern munich': 'Bayern München', 'bayern': 'Bayern München', 'man united': 'Manchester United', 'man utd': 'Manchester United',
  'man city': 'Manchester City', 'psg': 'Paris Saint Germain', 'paris': 'Paris Saint Germain', 'spurs': 'Tottenham',
  'tottenham hotspur': 'Tottenham', 'atletico': 'Atletico Madrid', 'atletico de madrid': 'Atletico Madrid', 'dortmund': 'Borussia Dortmund',
  'inter milan': 'Inter', 'milan': 'AC Milan', 'roma': 'AS Roma', 'besiktas': 'Beşiktaş', 'fenerbahce': 'Fenerbahçe',
  'leverkusen': 'Bayer Leverkusen', 'gladbach': 'Borussia Mönchengladbach', 'leipzig': 'RB Leipzig', 'freiburg': 'SC Freiburg',
  'augsburg': 'FC Augsburg', 'hearts': 'Heart Of Midlothian', 'porto': 'FC Porto', 'sporting': 'Sporting CP', 'psv': 'PSV Eindhoven',
  'stuttgart': 'VfB Stuttgart', 'frankfurt': 'Eintracht Frankfurt', 'forest': 'Nottingham Forest', 'wolverhampton': 'Wolves',
  'newcastle united': 'Newcastle', 'brighton & hove albion': 'Brighton', 'west ham united': 'West Ham', 'leeds united': 'Leeds',
  'betis': 'Real Betis', 'athletic bilbao': 'Athletic Club', 'hull': 'Hull City',
};
const plainName = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** [pattern, shirt, second] for a club. col is an optional lineups.team_colors row. */
function kitFor(name, col = null) {
  if (KITS[name]) return KITS[name];
  const low = plainName(name).toLowerCase();
  if (KIT_ALIAS[low]) return KITS[KIT_ALIAS[low]];
  const key = low.replace('fc ', '').trim();
  for (const [k, v] of Object.entries(KITS)) {
    const kk = plainName(k).toLowerCase();
    if (kk === key || kk.startsWith(key + ' ') || key.startsWith(kk + ' ') || kk.replace('fc ', '') === key) return v;
  }
  if (col && col.primary) {
    const a = `#${String(col.primary).replace('#', '')}`;
    let b = `#${String(col.number || col.border || 'FFFFFF').replace('#', '')}`;
    if (b.toUpperCase() === a.toUpperCase()) b = a.toUpperCase() !== '#FFFFFF' ? '#FFFFFF' : '#111111';
    return ['solid', a, b];
  }
  return ['solid', '#303439', '#85888E'];
}

function kitPattern(kind, b) {
  const r = (x, y, w, hh) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="${b}"/>`;
  if (kind === 'wide') return [0, 50].map(x => r(x, 0, 25, 100)).join('');
  if (kind === 'stripes') return [14, 38, 62, 86].map(x => r(x, 0, 12, 100)).join('');
  if (kind === 'hoops') return [14, 38, 62, 86].map(y => r(0, y, 100, 12)).join('');
  if (kind === 'halves') return r(50, 0, 50, 100);
  if (kind === 'centre') return r(36, 0, 28, 100);
  if (kind === 'sleeves') return r(0, 0, 22, 100) + r(78, 0, 22, 100);
  return '';
}

/** Patterned club-colour disc with a lower band in the second colour (shirt over shorts). */
function badgeImg(name, size, col) {
  const [kind, a, b] = kitFor(name, col);
  const ring = ['#FFFFFF', '#111111'].includes(a.toUpperCase()) ? '#30343A' : 'rgba(255,255,255,.18)';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    + '<defs><clipPath id="c"><circle cx="50" cy="50" r="48"/></clipPath></defs>'
    + `<g clip-path="url(#c)"><rect width="100" height="100" fill="${a}"/>${kitPattern(kind, b)}`
    + `<rect x="0" y="70" width="100" height="30" fill="${b}"/><rect x="0" y="68" width="100" height="3" fill="#0A0D11" opacity=".25"/></g>`
    + `<circle cx="50" cy="50" r="48" fill="none" stroke="${ring}" stroke-width="4"/></svg>`;
  return { type: 'img', props: { src: svgUri(svg), width: size, height: size, style: { flexShrink: 0 } } };
}

function flagClock(m) {
  if (m.period === 'HT') return 'HT';
  return m.minute != null ? `${m.minute}'` : 'LIVE';
}

// Tone colours, from the site tokens: --danger for alerts, --warning otherwise.
const TONE = {
  alert: { ink: '#FF646B', fill: 'rgba(255,100,107,0.10)', line: 'rgba(255,100,107,0.42)' },
  watch: { ink: '#FFF478', fill: 'rgba(255,244,120,0.09)', line: 'rgba(255,244,120,0.40)' },
};

const pill = (label, style = {}) => text(label, {
  borderRadius: 999, padding: '10px 22px', fontSize: 24, fontWeight: 600, whiteSpace: 'nowrap', ...style,
});

function scoreRow(name, goals, reds, note, tone, col, first) {
  return h('div', { alignItems: 'center', gap: 24, paddingTop: first ? 0 : 18, marginTop: first ? 0 : 18,
    borderTop: first ? 'none' : `2px solid ${C.border}` },
    badgeImg(name, 76, col),
    h('div', { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
      h('div', { alignItems: 'center', gap: 14 },
        text(name, { color: C.ink, fontSize: name.length > 18 ? 40 : 46, fontWeight: 700, letterSpacing: -1, maxWidth: 640 }),
        reds > 0 ? h('div', { gap: 6 }, Array.from({ length: Math.min(reds, 3) },
          () => h('div', { width: 20, height: 28, borderRadius: 4, backgroundColor: C.red }))) : null),
      note ? text(note, { color: tone.ink, fontSize: 21, fontWeight: 600, letterSpacing: 2, marginTop: 6 }) : null),
    h('div', { width: 92, height: 92, borderRadius: 22, backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      text(goals ?? 0, { color: C.ink, fontSize: 58, fontWeight: 700 })));
}

function statRow(label, home, away, fmt, first) {
  const a = Number(home) || 0, b = Number(away) || 0;
  const share = a + b > 0 ? a / (a + b) : 0.5;
  return h('div', { flexDirection: 'column', marginTop: first ? 0 : 16 },
    h('div', { justifyContent: 'space-between', alignItems: 'center' },
      text(fmt(home), { color: C.ink, fontSize: 28, fontWeight: 700, width: 140 }),
      text(label, { color: C.low, fontSize: 20, fontWeight: 600, letterSpacing: 3 }),
      text(fmt(away), { color: C.ink, fontSize: 28, fontWeight: 700, width: 140, justifyContent: 'flex-end' })),
    h('div', { height: 10, marginTop: 8, gap: share > 0 && share < 1 ? 6 : 0 },
      h('div', { width: `${(share * 100).toFixed(1)}%`, borderRadius: 5, backgroundColor: C.green }),
      h('div', { flexGrow: 1, borderRadius: 5, backgroundColor: '#3A3F46' })));
}

/**
 * One in-play flag as a square card. match is an /api/inplay tracker row,
 * flag one of its flags. Facts only: score, clock, the flag's own sentence and
 * the live stats. No price, no probability, no selection.
 * opts.colors: optional { home, away } lineups.team_colors rows, used for
 * clubs not in KITS.
 */
async function flagCard(match, flag, opts = {}) {
  const st = match.stats ?? null;
  const hs = st?.home ?? {}, as = st?.away ?? {};
  const tone = flag.tone === 'alert' ? TONE.alert : TONE.watch;
  const title = String(flag.title ?? '').toUpperCase();
  const stats = [];
  if (st && hs.xg != null && as.xg != null) stats.push(['XG', hs.xg, as.xg, v => Number(v).toFixed(2)]);
  if (st && hs.shotsOn != null && as.shotsOn != null) stats.push(['ON TARGET', hs.shotsOn, as.shotsOn, v => String(v)]);
  if (st && hs.possession != null && as.possession != null) stats.push(['POSSESSION', hs.possession, as.possession, v => `${v}%`]);
  const shown = stats.slice(0, 3);
  // A red-card flag always shows at least one card on its side, even when the
  // tracker row has no stats block to count them from.
  const redsFor = (side, n) => Math.max(Number(n) || 0, flag.kind === 'red-card' && flag.side === side ? 1 : 0);
  // Without the stats card the body is short, so it sits in the middle.
  const spacer = () => h('div', { flexGrow: 1 });

  const tree = h('div', { flexDirection: 'column', width: SQ, height: SQ, backgroundColor: C.page, fontFamily: 'Onest, OnestExt' },
    // Header bar: the site's green band with the black wordmark.
    h('div', { height: 112, backgroundColor: C.green, alignItems: 'center', justifyContent: 'space-between', padding: '0 56px', flexShrink: 0 },
      wordmark(40),
      pill('IN-PLAY FLAG', { backgroundColor: '#0A0D11', color: C.green, fontSize: 22, fontWeight: 700, letterSpacing: 2 })),
    h('div', { flexDirection: 'column', flexGrow: 1, padding: '32px 56px 0' },
      shown.length ? null : spacer(),
      // Chips: live clock, competition.
      h('div', { gap: 12, alignItems: 'center' },
        h('div', { alignItems: 'center', gap: 10, borderRadius: 999, padding: '10px 22px', backgroundColor: 'rgba(255,100,107,0.12)' },
          h('div', { width: 12, height: 12, borderRadius: 6, backgroundColor: C.red }),
          text(`LIVE  ${flagClock(match)}`, { color: '#FF646B', fontSize: 24, fontWeight: 700, letterSpacing: 1 })),
        match.league ? pill(match.league, { border: '2px solid #303439', color: C.mid, maxWidth: 640 }) : null),
      // Scoreboard.
      h('div', { flexDirection: 'column', marginTop: 20, backgroundColor: C.card, borderRadius: 36, padding: '24px 34px', flexShrink: 0 },
        scoreRow(match.homeTeam, match.homeGoals, redsFor('home', hs.reds), flag.side === 'home' ? title : null, tone, opts.colors?.home, true),
        scoreRow(match.awayTeam, match.awayGoals, redsFor('away', as.reds), flag.side === 'away' ? title : null, tone, opts.colors?.away, false)),
      // The flag itself.
      h('div', { marginTop: 16, borderRadius: 36, padding: '24px 34px 24px 26px', gap: 22, flexShrink: 0,
        backgroundColor: tone.fill, border: `2px solid ${tone.line}` },
        h('div', { width: 6, borderRadius: 3, backgroundColor: tone.ink, flexShrink: 0 }),
        text(flag.detail ?? '', { color: C.ink, fontSize: 31, fontWeight: 500, lineHeight: 1.3, flexGrow: 1, minWidth: 0 })),
      // Live stats, when the tracker has them.
      shown.length ? h('div', { flexDirection: 'column', marginTop: 16, backgroundColor: C.card, borderRadius: 36, padding: '22px 34px', flexShrink: 0 },
        shown.map(([l, a, b, f], i) => statRow(l, a, b, f, i === 0))) : null,
      spacer(),
      h('div', { justifyContent: 'space-between', alignItems: 'center', padding: '18px 0 26px', borderTop: `2px solid ${C.border}`, marginTop: 14, flexShrink: 0 },
        text('18+  ·  Live match facts, not advice', { color: C.dim, fontSize: 21 }),
        text('maxedge.live', { color: C.ink, fontSize: 24, fontWeight: 600 }))));
  return render(tree, SQ, SQ);
}

module.exports = { trendsCard, playersCard, moversCard, edgeCard, flagCard, teamMark, kitFor, ukTime };
