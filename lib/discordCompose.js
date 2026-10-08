'use strict';

/**
 * lib/discordCompose — HOW a Discord post is worded, and nothing else.
 *
 * Pure functions, no I/O. Whether a signal may be posted at all is decided
 * upstream by postToX's double gate (`isBroadcastable`) and the publication
 * gate inside `fetchRecentSignals`. This file never re-decides that: the
 * Telegram header records what happened the last time a channel worked out
 * its own band (PRIME posted for selections the site badged WATCH).
 *
 * ── THE COPY RULES THIS FILE ENFORCES (public copy standard, 23 Aug 2026) ──
 *
 *  1. MaxEdge is an aggregator. Every price is either a BOOK's price (named)
 *     or the market's FAIR price. Never "our price".
 *  2. The fair price is printed on every selection, not just the edge %.
 *     The best quoted price is only true for whoever can hold that book; the
 *     fair price is true for every reader.
 *  3. PRIME and EDGE never share copy. EDGE always carries its scope line.
 *  4. Results post losses exactly as they post wins.
 *  5. No engineering vocabulary, no profit promises, 18+ on every post.
 *
 * `assertClean` is the ratchet for rules 1 and 5. A refusal throws rather than
 * softening the text, so a bad template fails a test instead of reaching a
 * channel.
 */

const { bookmakerLabel } = require('./bookmakers');

const SITE = 'https://maxedge.live';

/** Colours: words carry the distinction, colour only supports it. */
const COLOUR = {
  PRIME:  0xADEA82,   // bar green (8 Oct 2026 brand ruling)
  EDGE:   0x4FC58A,
  WIN:    0x4FC58A,
  LOSS:   0x8A8F98,
  VOID:   0x5B616B,
  RECORD: 0xADEA82,
};

const FOOTER = '18+ · Information only, we never place bets · BeGambleAware.org';

/**
 * Words and phrases that may never reach a public post. Matched
 * case-insensitively on word boundaries. Extend, never shrink, without a
 * decision recorded in the public copy standard.
 */
const BANNED = [
  'our price', 'our odds', 'guaranteed', 'guarantee', 'sure thing', 'lock',
  'risk free', 'risk-free', 'can\'t lose', 'cannot lose', 'banker', 'free money',
  'easy money', 'profit', 'get rich', 'max bet', 'all in',
  // engineering vocabulary (public copy standard)
  'brier', 'sigma', 'z-score', 'shin', 'de-vigged', 'devigged', 'clustered',
  'migration', 'paper_trade_gate', 'withheld',
];

class ComposeRefusal extends Error {
  constructor(term, where) {
    super(`refused: "${term}" in ${where}`);
    this.term = term;
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Throws ComposeRefusal if any banned term appears anywhere in the payload. */
function assertClean(payload, where = 'post') {
  const text = JSON.stringify(payload).toLowerCase();
  for (const term of BANNED) {
    const re = new RegExp(`(^|[^a-z])${escapeRe(term)}([^a-z]|$)`, 'i');
    if (re.test(text)) throw new ComposeRefusal(term, where);
  }
  return payload;
}

/** Fair price from the stored edge. edge = p·odds − 1, so fair = odds / (1 + edge). */
function fairPrice(odds, edge) {
  const o = Number(odds), e = Number(edge);
  if (!Number.isFinite(o) || !Number.isFinite(e) || o <= 1 || e <= -1) return null;
  return o / (1 + e);
}

function unix(iso) { return Math.floor(new Date(iso).getTime() / 1000); }

/** Discord renders <t:…> in each reader's own time zone. */
function kickoffTag(iso) {
  if (!iso) return 'TBC';
  const t = unix(iso);
  return `<t:${t}:f> (<t:${t}:R>)`;
}

const OUTCOME_LABEL = {
  home: null, away: null, draw: 'Draw',
  over: 'Over', under: 'Under',
  btts_yes: 'Both teams to score: Yes', btts_no: 'Both teams to score: No',
};

/** Human selection text, e.g. "Nantes to win", "Over 2.5 goals". */
function selectionText(signal) {
  const home = signal.match?.home_team?.name ?? 'Home';
  const away = signal.match?.away_team?.name ?? 'Away';
  const o = String(signal.outcome ?? '').toLowerCase();
  const line = signal.market_line != null ? ` ${Number(signal.market_line)}` : '';
  if (o === 'home') return `${home} to win`;
  if (o === 'away') return `${away} to win`;
  if (o === 'over' || o === 'under') return `${OUTCOME_LABEL[o]}${line} goals`;
  return OUTCOME_LABEL[o] ?? o.replace(/_/g, ' ');
}

function fixtureText(signal) {
  const home = signal.match?.home_team?.name ?? 'Home';
  const away = signal.match?.away_team?.name ?? 'Away';
  return `${home} v ${away}`;
}

/** Forum thread title: short, unique enough, no figures that go stale. */
function threadName(signal) {
  return `${fixtureText(signal)} · ${selectionText(signal)}`.slice(0, 100);
}

/**
 * A PRIME or EDGE signal. `rung` comes from postToX's rungOf, never from here.
 */
function signalPost(signal, rung, { delayed = false } = {}) {
  if (rung !== 'PRIME' && rung !== 'EDGE') {
    throw new Error(`signalPost: rung must be PRIME or EDGE, got ${rung}`);
  }
  const odds = Number(signal.detected_odds);
  const edge = Number(signal.detected_edge);
  const fair = fairPrice(odds, edge);
  const book = bookmakerLabel(signal.bookmaker) ?? 'Best available book';
  const league = signal.match?.league?.name ?? null;

  const fields = [
    { name: 'Selection', value: selectionText(signal), inline: false },
    { name: `Best price (${book})`, value: odds.toFixed(2), inline: true },
    { name: 'Fair price', value: fair ? fair.toFixed(2) : 'n/a', inline: true },
    { name: 'Gap', value: `+${(edge * 100).toFixed(1)}%`, inline: true },
    { name: 'Kick-off', value: kickoffTag(signal.kickoff_at), inline: false },
  ];

  const lines = [
    league ? `*${league}*` : null,
    rung === 'EDGE'
      ? 'EDGE is posted and settled like PRIME but reported separately, outside the headline record.'
      : null,
    'Prices move. Check the book before you act, and only take a price at or above the fair line.',
    delayed ? `*Plus members saw this first. [See plans](${SITE}/pricing)*` : null,
  ].filter(Boolean);

  const payload = {
    embeds: [{
      title: `${rung} · ${fixtureText(signal)}`.slice(0, 256),
      url: `${SITE}/market-pulse`,
      description: lines.join('\n'),
      color: COLOUR[rung],
      fields,
      footer: { text: FOOTER },
      timestamp: signal.detected_at ?? undefined,
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'signalPost');
}

const RESULT_WORD = { win: 'WON', loss: 'LOST', void: 'VOID', push: 'VOID' };

/**
 * A settled signal. Losses get the same layout and weight as wins; there is
 * no branch that hides or softens one.
 */
function resultPost(signal, rung) {
  const r = String(signal.result ?? '').toLowerCase();
  const word = RESULT_WORD[r];
  if (!word) throw new Error(`resultPost: unsettled result "${signal.result}"`);
  const odds = Number(signal.detected_odds);
  const units = r === 'win' ? odds - 1 : r === 'loss' ? -1 : 0;
  const gh = signal.match?.goals_home, ga = signal.match?.goals_away;
  const score = gh != null && ga != null ? `${gh}-${ga}` : 'n/a';
  const closing = signal.closing_odds != null ? Number(signal.closing_odds).toFixed(2) : 'n/a';

  const fields = [
    { name: 'Selection', value: selectionText(signal), inline: false },
    { name: 'Final score', value: score, inline: true },
    { name: 'Price posted', value: odds.toFixed(2), inline: true },
    { name: 'Closing price', value: closing, inline: true },
    { name: 'Result (1 unit)', value: `${units >= 0 ? '+' : ''}${units.toFixed(2)}u`, inline: true },
  ];
  if (signal.closing_odds != null) {
    const beat = odds > Number(signal.closing_odds);
    fields.push({ name: 'Beat the close?', value: beat ? 'Yes' : 'No', inline: true });
  }

  const payload = {
    embeds: [{
      title: `${word} · ${rung ?? ''} · ${fixtureText(signal)}`.replace(/ ·  · /, ' · ').slice(0, 256),
      url: `${SITE}/performance`,
      description: rung === 'EDGE'
        ? 'EDGE result. Reported on the EDGE tab, not in the headline record.'
        : 'Counted in the published record.',
      color: COLOUR[r === 'win' ? 'WIN' : r === 'loss' ? 'LOSS' : 'VOID'],
      fields,
      footer: { text: FOOTER },
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'resultPost');
}

function pct(x, dp = 1) { return `${(Number(x) * 100).toFixed(dp)}%`; }

/**
 * The weekly record, straight from `performance_band`.
 *
 * Only `published` bands. The `internal` PRIME + EDGE row is never shown: the
 * merge question was answered with numbers on 26 Aug and merging makes every
 * figure worse. Yield is shown only when the band has cleared its gate;
 * otherwise `insufficient_reason` is printed verbatim and the yield waits.
 * The headline scope note is printed whenever the headline band is.
 */
function weeklyRecordPost(bands) {
  const shown = (bands ?? [])
    .filter(b => b.published && b.record_role !== 'internal')
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (!shown.length) throw new Error('weeklyRecordPost: no published bands');

  const fields = shown.map(b => {
    const parts = [
      `${b.settled_fixtures} settled matches · ${b.wins}W ${b.losses}L`,
      `Strike ${pct(b.win_rate)} vs ${pct(b.breakeven_strike)} needed to break even`,
      b.insufficient
        ? `Yield: not published yet. ${b.insufficient_reason}`
        : `Yield ${Number(b.yield) >= 0 ? '+' : ''}${pct(b.yield)} · ${Number(b.units) >= 0 ? '+' : ''}${Number(b.units).toFixed(2)}u`,
    ];
    if (b.headline_scope_note) parts.push(`*${b.headline_scope_note}*`);
    const label = b.record_role === 'headline' ? `${b.band_label} (headline record)` : b.band_label;
    return { name: label, value: parts.join('\n').slice(0, 1024), inline: false };
  });

  const payload = {
    embeds: [{
      title: 'The weekly record',
      url: `${SITE}/performance`,
      description: 'Every settled signal, wins and losses. Full history on the record page.',
      color: COLOUR.RECORD,
      fields,
      footer: { text: FOOTER },
      timestamp: shown[0].calculated_at ?? undefined,
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'weeklyRecordPost');
}

module.exports = {
  signalPost, resultPost, weeklyRecordPost, threadName, selectionText, fixtureText,
  fairPrice, assertClean, ComposeRefusal, BANNED, COLOUR, FOOTER,
};
