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

/** API-Football ids: EPL, Championship, La Liga, Serie A, Bundesliga, Ligue 1, UCL, UEL, SPL. */
const DEFAULT_LEAGUES = ['39', '40', '140', '135', '78', '61', '2', '3', '179'];
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

module.exports = { xEligible, xFlagText, leaguesFrom, FRAMES, X_FOOTER, DEFAULT_LEAGUES, X_KINDS };
