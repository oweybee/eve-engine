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
const FOOT = '18+  ·  Information only, we never place bets  ·  BeGambleAware.org';

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

// Square on purpose: 1080x1080 shows uncropped in a Discord channel, an X
// timeline and an Instagram feed, so one PNG serves every channel.
const SQ = 1080;

/** Three-letter mark in place of a crest: crests are club trademarks. */
function teamMark(name) {
  const words = String(name ?? '').replace(/[^A-Za-zÀ-ž0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !/^(FC|AFC|CF|SC|AC|FK|SK|CD|SV|VfB|VfL|1\.)$/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

function flagClock(m) {
  if (m.period === 'HT') return 'HT';
  return m.minute != null ? `${m.minute}'` : 'LIVE';
}

function flagTeamRow(name, goals, reds, flagged) {
  return h('div', { alignItems: 'center', gap: 26, marginTop: 22 },
    h('div', { width: 76, height: 76, borderRadius: 38, backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center',
      border: `2px solid ${flagged ? C.yellow : C.border}` },
      text(teamMark(name), { color: C.ink, fontSize: 24, fontWeight: 700, letterSpacing: 1 })),
    h('div', { flexGrow: 1, alignItems: 'center', gap: 16, minWidth: 0 },
      text(name, { color: C.ink, fontSize: 48, fontWeight: 600, maxWidth: 720 }),
      reds > 0 ? h('div', { gap: 6 }, Array.from({ length: Math.min(reds, 3) },
        () => h('div', { width: 22, height: 32, borderRadius: 4, backgroundColor: C.red }))) : null),
    text(goals ?? 0, { color: C.ink, fontSize: 72, fontWeight: 700 }));
}

function statBar(label, home, away, fmt) {
  const a = Number(home) || 0, b = Number(away) || 0;
  const share = a + b > 0 ? a / (a + b) : 0.5;
  return h('div', { flexDirection: 'column', marginTop: 26 },
    h('div', { justifyContent: 'space-between', alignItems: 'baseline' },
      text(fmt(home), { color: C.ink, fontSize: 34, fontWeight: 700 }),
      text(label, { color: C.low, fontSize: 24, fontWeight: 600, letterSpacing: 3 }),
      text(fmt(away), { color: C.ink, fontSize: 34, fontWeight: 700 })),
    h('div', { height: 12, borderRadius: 6, marginTop: 10, backgroundColor: C.tile, overflow: 'hidden' },
      h('div', { width: `${(share * 100).toFixed(1)}%`, backgroundColor: C.red }),
      h('div', { flexGrow: 1, backgroundColor: C.green })));
}

/**
 * One in-play flag as a square card. match is an /api/inplay tracker row,
 * flag one of its flags. Facts only: score, clock, the flag's own sentence and
 * the live stats. No price, no probability, no selection.
 */
async function flagCard(match, flag) {
  const st = match.stats ?? null;
  const hs = st?.home ?? {}, as = st?.away ?? {};
  const alert = flag.tone === 'alert';
  const rows = [];
  if (st && hs.xg != null && as.xg != null) rows.push(statBar('XG', hs.xg, as.xg, v => Number(v).toFixed(2)));
  if (st && hs.shotsOn != null && as.shotsOn != null) rows.push(statBar('ON TARGET', hs.shotsOn, as.shotsOn, v => String(v)));
  if (st && hs.possession != null && as.possession != null) rows.push(statBar('POSSESSION', hs.possession, as.possession, v => `${v}%`));

  const tree = h('div', { flexDirection: 'column', width: SQ, height: SQ, backgroundColor: C.page, padding: 64, fontFamily: 'Onest, OnestExt' },
    h('div', { justifyContent: 'space-between', alignItems: 'center' },
      h('div', { alignItems: 'center', gap: 14 },
        h('div', { width: 16, height: 16, borderRadius: 8, backgroundColor: C.red }),
        text(flagClock(match), { color: C.ink, fontSize: 30, fontWeight: 700 }),
        text(match.league ?? '', { color: C.mid, fontSize: 28, maxWidth: 560 })),
      h('div', { flexDirection: 'column', alignItems: 'flex-end', lineHeight: 0.95 },
        text('MAX', { color: C.ink, fontSize: 28, fontWeight: 700, letterSpacing: 2 }),
        text('EDGE', { color: C.green, fontSize: 28, fontWeight: 700, letterSpacing: 2 }))),
    h('div', { flexDirection: 'column', marginTop: 20 },
      flagTeamRow(match.homeTeam, match.homeGoals, hs.reds ?? 0, flag.side === 'home'),
      flagTeamRow(match.awayTeam, match.awayGoals, as.reds ?? 0, flag.side === 'away')),
    h('div', { marginTop: 36, backgroundColor: C.card, borderRadius: 20, padding: '26px 32px 26px 26px', gap: 22,
      border: `1px solid ${C.border}` },
      h('div', { width: 6, borderRadius: 3, backgroundColor: alert ? C.red : C.yellow }),
      h('div', { flexDirection: 'column', flexGrow: 1, minWidth: 0 },
        text(`IN-PLAY FLAG  ·  ${String(flag.title ?? '').toUpperCase()}`, { color: alert ? C.red : C.yellow, fontSize: 24, fontWeight: 700, letterSpacing: 2 }),
        text(flag.detail ?? '', { color: C.ink, fontSize: 32, marginTop: 12, lineHeight: 1.35 }))),
    rows.length ? h('div', { flexDirection: 'column', marginTop: 8 }, rows) : null,
    h('div', { flexGrow: 1 }),
    h('div', { justifyContent: 'space-between', alignItems: 'center', paddingTop: 22, borderTop: `1px solid ${C.border}` },
      text('maxedge.live', { color: C.ink, fontSize: 24, fontWeight: 600 }),
      text('Live match facts, not tips  ·  18+  ·  BeGambleAware.org', { color: C.dim, fontSize: 20 })));
  return render(tree, SQ, SQ);
}

module.exports = { trendsCard, moversCard, edgeCard, flagCard, teamMark, ukTime };
