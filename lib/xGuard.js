'use strict';

/**
 * lib/xGuard — the rails an UNATTENDED poster needs, and why each one exists.
 *
 * The founder chose fully automatic posting on 28 Sep 2026 over a draft queue.
 * That is a legitimate call and this file is what makes it survivable: every
 * check here is one a human reviewer would have performed by eye, written down
 * so it happens on every post instead of on the ones somebody looked at.
 *
 * ── 1. STRUCTURAL SIMILARITY, WHICH IS THE ONE THAT COSTS THE ACCOUNT ───────
 *
 * X's automation rules prohibit "duplicative or substantially similar posts",
 * and a templated signal bot is the textbook trigger. The ledger's
 * `message_hash` does not help: it catches an IDENTICAL post, and a templated
 * poster never emits one — it emits the same sentence with a different team and
 * a different price, which is precisely what the rule is aimed at.
 *
 * So the comparison is on the SKELETON: the post with every number, price,
 * percentage, club, competition and URL replaced by a placeholder. Two posts
 * from the same template have the same skeleton however different their
 * figures. A skeleton that has already gone out inside the window is refused,
 * which forces the caller to rotate its phrasing rather than merely its data.
 *
 * That is a deliberate design pressure, not a nuisance: rotation is the actual
 * remedy the rule asks for, and a guard that can be satisfied by changing a
 * number would be a guard against nothing.
 *
 * ── 2. THE DAILY CAP ────────────────────────────────────────────────────────
 *
 * Volume alone reads as automation. The cap is low on purpose and counts
 * everything the channel sent today, not per post type, because the audience
 * sees one timeline.
 *
 * ── 3. THE KILL SWITCH ──────────────────────────────────────────────────────
 *
 * Read before every post, from the environment, so the channel can be stopped
 * without a deploy. It FAILS CLOSED: an unreadable or absent switch stops the
 * poster. An unattended poster that keeps going when it cannot confirm it is
 * allowed to is the failure mode this whole file exists to prevent, and X
 * supplies about half the site's arrivals.
 */

/** Posts per calendar day, all types counted together. */
const DAILY_CAP = Number(process.env.X_DAILY_CAP ?? 4);

/**
 * How many recent posts a skeleton must be absent from.
 *
 * THE WINDOW MUST BE SMALLER THAN THE VARIANT COUNT OR THE POSTER DEADLOCKS,
 * and it deadlocks silently — every candidate refused, nothing posted, no
 * error. `xCompose` ships six phrasings per post type; four is the window, so
 * a shape is reusable once two others have gone out after it. Raising this
 * past five with six variants stops the channel. `variantsFor` in xCompose and
 * this number are one decision in two files, which is why both say so.
 */
const SIMILARITY_WINDOW = Number(process.env.X_SIMILARITY_WINDOW ?? 4);

/**
 * Reduce a post to its shape.
 *
 * ORDER MATTERS. URLs go first because they contain digits and dots that the
 * number rule would otherwise chew into an unrecognisable stub, which would
 * make two posts linking to different pages look like different shapes when
 * they are the same shape.
 */
function skeletonOf(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' URL ')
    // Prices, percentages and counts, signed, with a real minus or an ASCII one.
    .replace(/[+−-]?\d+(?:[.,]\d+)?%?/g, ' N ')
    // Proper nouns: any run of capitalised words is a club, a competition or a
    // bookmaker. Done after numbers so "CFR 1907 Cluj" collapses whole.
    .replace(/\b[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)*/g, ' X ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when this shape has gone out inside the window. */
function tooSimilar(skeleton, recentSkeletons, window = SIMILARITY_WINDOW) {
  if (!skeleton) return true;
  return (recentSkeletons ?? []).slice(0, window).includes(skeleton);
}

/**
 * Is the channel switched on?
 *
 * FAILS CLOSED. Only the exact string '1' enables it. Unset, empty, '0',
 * 'true', a typo — all off. A switch that can be turned on by accident is not a
 * switch.
 */
function channelEnabled(env = process.env) {
  return env.X_POSTING_ENABLED === '1';
}

/**
 * The single decision. Returns `{ ok: true }` or `{ ok: false, reason }`, and
 * never throws — a guard that throws on a malformed input is a guard that can
 * be crashed past.
 */
function mayPost({ text, recentSkeletons = [], postedToday = 0, env = process.env }) {
  if (!channelEnabled(env)) return { ok: false, reason: 'channel-disabled' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };

  const cap = Number(env.X_DAILY_CAP ?? DAILY_CAP);
  if (Number.isFinite(cap) && postedToday >= cap) {
    return { ok: false, reason: 'daily-cap', detail: `${postedToday}/${cap}` };
  }

  const skeleton = skeletonOf(text);
  const window = Number(env.X_SIMILARITY_WINDOW ?? SIMILARITY_WINDOW);
  if (tooSimilar(skeleton, recentSkeletons, window)) {
    return { ok: false, reason: 'too-similar', detail: skeleton.slice(0, 60) };
  }

  return { ok: true, skeleton };
}

module.exports = {
  skeletonOf, tooSimilar, channelEnabled, mayPost,
  DAILY_CAP, SIMILARITY_WINDOW,
};
