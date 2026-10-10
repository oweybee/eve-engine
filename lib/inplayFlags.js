'use strict';

/**
 * lib/inplayFlags — turning the /in-play tracker's flags into Discord posts.
 *
 * ── THE RULES ARE NOT HERE ──────────────────────────────────────────────────
 *
 * Whether a match deserves a flag is decided once, in eve-frontend
 * lib/inplayTracker (favourite behind, red card, one-way pressure, goals
 * expected none yet, favourite drifting). postInplayFlags.js reads the site's
 * own /api/inplay and posts what it already says, so the channel and the page
 * cannot disagree. This module only decides WHICH flags are new and how a post
 * reads.
 *
 * ── FACTS, NOT PICKS ────────────────────────────────────────────────────────
 *
 * The in-play ruling (9 Oct) is "show the live state, do not show in-play
 * opportunities". A post carries the score, the clock and the flag's own
 * sentence. No price, no edge, no stake, no selection, and no word telling
 * anyone to bet. assertClean refuses the post rather than softening it.
 */

const { assertClean, FOOTER } = require('./discordCompose');

const SITE = 'https://maxedge.live';
const ALERT_COLOUR = 0xE5484D;     // red card, favourite behind
const WATCH_COLOUR = 0xF5A524;     // pressure, goals expected, drift

/** No flag is posted this late: there is nothing left for a reader to watch. */
const LATEST_MINUTE = 85;
/** A busy match should not fill the channel. */
const MAX_FLAGS_PER_MATCH = 4;

const ICON = {
  'red-card': '🟥',
  'fav-trailing': '⚠️',
  pressure: '📈',
  'goals-due': '⏱️',
  drift: '📉',
};

/**
 * The ledger key for one flag. Kind plus side, so the same flag read again on
 * the next poll is not a new post. A red card also keys on its count, so a
 * second red on the same side IS a new post.
 */
function flagKey(flag) {
  const side = flag.side ?? 'match';
  if (flag.kind === 'red-card') {
    const n = /^(\d+) red cards/.exec(flag.title ?? '');
    return `red-card:${side}:${n ? n[1] : 1}`;
  }
  return `${flag.kind}:${side}`;
}

/** Is the match at a point where a new post still makes sense? */
function postable(match) {
  if (!match || typeof match.id !== 'string') return false;
  if (['FT', 'AET', 'PEN'].includes(match.period)) return false;
  if (match.minute != null && match.minute > LATEST_MINUTE) return false;
  return true;
}

/**
 * The flags still to post, given what the ledger already holds.
 *   tracker  the /api/inplay `tracker` array
 *   posted   Map<matchId, Set<flagKey>> from inplay_flag_posts
 */
function newFlags(tracker, posted) {
  const out = [];
  for (const m of tracker ?? []) {
    if (!postable(m)) continue;
    const done = posted.get(m.id) ?? new Set();
    let room = MAX_FLAGS_PER_MATCH - done.size;
    for (const f of m.flags ?? []) {
      if (room <= 0) break;
      const key = flagKey(f);
      if (done.has(key)) continue;
      out.push({ match: m, flag: f, key });
      room--;
    }
  }
  return out;
}

function clock(m) {
  if (m.period === 'HT') return 'HT';
  return m.minute != null ? `${m.minute}'` : 'Live';
}

/** One Discord post for one flag. */
function flagPost(match, flag) {
  const score = `${match.homeGoals}–${match.awayGoals}`;
  const payload = {
    embeds: [{
      title: `${ICON[flag.kind] ?? '•'} ${flag.title}`,
      url: `${SITE}/match/${match.id}`,
      description: `**${match.homeTeam} ${score} ${match.awayTeam}** · ${clock(match)}` +
        `${match.league ? ` · ${match.league}` : ''}\n${flag.detail}`,
      color: flag.tone === 'alert' ? ALERT_COLOUR : WATCH_COLOUR,
      footer: { text: `Live match facts, not tips. ${FOOTER}` },
    }],
    allowed_mentions: { parse: [] },
  };
  return assertClean(payload, 'flagPost');
}

/**
 * The same post with the square card attached as the embed image. The embed
 * text stays, so the post still reads (and searches) without the picture.
 */
function withCard(payload, filename) {
  const [e, ...rest] = payload.embeds;
  return { ...payload, embeds: [{ ...e, image: { url: `attachment://${filename}` } }, ...rest] };
}

module.exports = {
  flagKey, postable, newFlags, flagPost, withCard,
  LATEST_MINUTE, MAX_FLAGS_PER_MATCH,
};
