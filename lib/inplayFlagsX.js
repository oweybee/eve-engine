'use strict';

/**
 * lib/inplayFlagsX — which in-play flags also go to X, and how a post reads.
 *
 * Discord #in-play gets every flag. X gets a narrow public subset, because X
 * is a public timeline under automation rules and every post is paid for:
 *
 *   - Only the two ALERT kinds, red card and favourite behind. Pressure,
 *     goals-due and drift are interpretive; on a public feed they read as
 *     nudges, which is the line the 9 Oct in-play ruling draws.
 *   - Only big competitions, matched by API-Football league id, never by name:
 *     "Premier League" is England AND Russia, "Serie A" is Italy AND Brazil,
 *     "Bundesliga" is Germany AND Austria in our own leagues table.
 *   - No link in the text. X charges a link surcharge per post and suppresses
 *     link posts; the card already carries maxedge.live.
 *
 * ── PHRASING ROTATES, ON PURPOSE ────────────────────────────────────────────
 * X prohibits "duplicative or substantially similar posts". lib/xGuard refuses
 * a post whose skeleton (numbers, names and URLs stripped) went out inside the
 * last X_SIMILARITY_WINDOW posts. There are six frames here, more than the
 * window of four, so a free frame always exists. Fewer frames than the window
 * deadlocks the channel silently.
 *
 * Facts only, the same contract as lib/inplayFlags: score, clock, the flag's
 * own sentence. No price, no probability, no selection, no word telling anyone
 * to bet. assertClean refuses the post rather than softening it.
 */

const { assertClean } = require('./discordCompose');

const X_FOOTER = '18+ | begambleaware | Live match facts, not advice';

/**
 * API-Football ids. England: Premier League 39, Championship 40, League One 41,
 * League Two 42. Europe: La Liga 140, Serie A 135, Bundesliga 78, Ligue 1 61,
 * Eredivisie 88, Primeira Liga 94, Belgian Pro League 144, Scottish
 * Premiership 179. UEFA: Champions League 2, Europa League 3.
 * Widened on 11 Oct 2026 (owner): the first nine produced about three posts
 * on a full Saturday, well under the daily cap.
 */
const DEFAULT_LEAGUES = ['39', '40', '41', '42', '140', '135', '78', '61', '88', '94', '144', '179', '2', '3'];
const X_KINDS = new Set(['red-card', 'fav-trailing']);

function leaguesFrom(env = process.env) {
  const raw = String(env.X_INPLAY_LEAGUES ?? '').trim();
  if (!raw) return new Set(DEFAULT_LEAGUES);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/** Does this flag go to X? leagueExt is the match's API-Football league id. */
function xEligible(flag, leagueExt, leagues = leaguesFrom()) {
  if (!flag || !X_KINDS.has(flag.kind)) return false;
  if (leagueExt == null || !leagues.has(String(leagueExt))) return false;
  return true;
}

/**
 * ── TIMING (owner, 11 Oct 2026) ─────────────────────────────────────────────
 * The first live post was a red card shown at 83' that had happened at 66'.
 * A flag on X is only worth posting while there is a game left to watch and
 * while it is news. Discord keeps every flag; these rules are X only.
 *   - Nothing after X_LATEST_MINUTE (70').
 *   - A red card is posted only within X_RED_STALE_MIN (10) minutes of the
 *     sending-off, read from the flag's own "(66')" text.
 *   - Favourite-behind comes first in a pass, earliest minute first, and red
 *     cards are capped per day so they cannot use up the daily budget.
 */
const X_LATEST_MINUTE = 70;
const X_RED_STALE_MIN = 10;

/** The minute an event happened, from "sent off (66')" or "(90+2')". */
function eventMinute(flag) {
  const m = /\((\d+)(?:\+(\d+))?'\)/.exec(String(flag?.detail ?? ''));
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

/** Is this flag still news at the match's current minute? */
function xFresh(match, flag) {
  const now = match?.minute == null ? NaN : Number(match.minute);
  if (match?.period === 'HT') return flag.kind !== 'red-card' || (eventMinute(flag) ?? 0) >= 40;
  if (!Number.isFinite(now)) return false;
  if (now > X_LATEST_MINUTE) return false;
  if (flag.kind === 'red-card') {
    const at = eventMinute(flag);
    if (at == null || now - at > X_RED_STALE_MIN) return false;
  }
  return true;
}

/** Order for one pass: favourite behind first, then the earliest minute. */
function xPriority(a, b) {
  const rank = f => (f.kind === 'fav-trailing' ? 0 : 1);
  return rank(a.flag) - rank(b.flag) || (Number(a.match.minute) || 0) - (Number(b.match.minute) || 0);
}

const clock = m => (m.period === 'HT' ? 'half-time' : m.minute != null ? `${m.minute}'` : 'live');
const scoreLine = m => `${m.homeTeam} ${m.homeGoals}-${m.awayGoals} ${m.awayTeam}`;
const sentence = s => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Six frames. Each has a different shape once names and numbers are removed. */
const FRAMES = [
  (m, f) => `${f.title}, ${clock(m)}.\n\n${scoreLine(m)}\n${sentence(f.detail)}`,
  (m, f) => `${scoreLine(m)}, ${clock(m)}\n\n${sentence(f.detail)}\n\nFrom the live tracker, facts only.`,
  (m, f) => `In play at ${clock(m)}: ${scoreLine(m)}.\n\n${sentence(f.detail)}`,
  (m, f) => `${m.league ?? 'Live'} flag.\n\n${sentence(f.detail)}\n\nScore right now: ${scoreLine(m)}.`,
  (m, f) => `Live tracker just raised this one.\n\n${scoreLine(m)} (${clock(m)})\n${sentence(f.detail)}`,
  (m, f) => `${sentence(f.detail)}\n\nAs it stands, ${clock(m)}: ${scoreLine(m)}. The full card is below.`,
];

/** The text for frame i (wraps), with the footer. Throws ComposeRefusal if unclean. */
function xFlagText(match, flag, i = 0) {
  const frame = FRAMES[((i % FRAMES.length) + FRAMES.length) % FRAMES.length];
  const text = `${frame(match, flag)}\n\n${X_FOOTER}`;
  assertClean({ text }, 'xFlagText');
  return text;
}

module.exports = { xEligible, xFresh, xPriority, eventMinute, xFlagText, leaguesFrom, FRAMES, X_FOOTER, DEFAULT_LEAGUES, X_KINDS, X_LATEST_MINUTE, X_RED_STALE_MIN };
