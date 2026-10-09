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

async function render(tree, height) {
  const { default: satori } = await import('satori');
  const { Resvg } = require('@resvg/resvg-js');
  const svg = await satori(tree, { width: W, height, fonts: fonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

// ── trends ──────────────────────────────────────────────────────────────────

function squares(hits) {
  return h('div', { gap: 6 }, hits.map(hit =>
    h('div', { width: 26, height: 26, borderRadius: 6, backgroundColor: hit ? C.green : C.red })));
}

function teamRow(name, form, field) {
  return h('div', { alignItems: 'center', gap: 18, marginTop: 10 },
    squares(form.seq[field]),
    text(`${form[field]}/${form.n}`, { color: C.ink, fontSize: 24, fontWeight: 700, width: 64 }),
    text(name, { color: C.mid, fontSize: 24 }));
}

function trendSection(title, field, list) {
  return h('div', { flexDirection: 'column', backgroundColor: C.card, borderRadius: 16, padding: '24px 28px', marginTop: 18, border: `1px solid ${C.border}` },
    text(title, { color: C.ink, fontSize: 28, fontWeight: 700, marginBottom: 6 }),
    list.map((f, i) => h('div', { flexDirection: 'column', marginTop: i ? 22 : 10 },
      h('div', { justifyContent: 'space-between', alignItems: 'baseline' },
        text(`${f.home_team?.name ?? 'Home'} v ${f.away_team?.name ?? 'Away'}`, { color: C.ink, fontSize: 24, fontWeight: 600 }),
        text(`${ukTime(f.kickoff_at)} UK`, { color: C.low, fontSize: 22 })),
      teamRow(f.home_team?.name ?? 'Home', f.h, field),
      teamRow(f.away_team?.name ?? 'Away', f.a, field))));
}

/** sections: [{ title, field, list }] from discordDigest.trendSections */
async function trendsCard(sections, { now = new Date() } = {}) {
  const rows = sections.reduce((n, s) => n + s.list.length, 0);
  const height = 260 + sections.length * 86 + rows * 133;
  const tree = h('div', { flexDirection: 'column', width: W, height, backgroundColor: C.page, padding: 48, fontFamily: 'Onest, OnestExt' },
    header("TODAY'S TRENDS", `${ukDay(now)}  ·  last 10 games, oldest to newest`),
    sections.map(s => trendSection(s.title, s.field, s.list)),
    h('div', { flexGrow: 1 }),
    footer());
  return render(tree, height);
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

module.exports = { trendsCard, moversCard, ukTime };
