'use strict';

/**
 * lib/xCompose — the words that go on X, and the rules they cannot break.
 *
 * ── WHY COMPOSITION IS A LIBRARY AND NOT A TEMPLATE STRING ──────────────────
 *
 * Every rule below is one the account can be actioned or the business fined
 * for, and a rule enforced by template discipline is a rule enforced until
 * somebody edits the template in a hurry. So each one is a function with a test
 * behind it, and `compose` REFUSES rather than degrades: a post that cannot be
 * built inside the rules is not posted. On an unattended poster, refusing is
 * the only safe failure.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *
 * 1. THE FOOTER IS MANDATORY AND EXACT. `18+ | begambleaware | Pricing
 *    analysis, not advice`. Plain text on purpose: `begambleaware.org` as a
 *    link is suppressed by X's algorithm and a suppressed compliance line is a
 *    missing one.
 * 2. NO EMOJI ON A POST NAMING A SELECTION, A PRICE OR AN OFFER. Youth-appeal
 *    flag under CAP. The check is on the whole composed post, not on the part
 *    the caller wrote.
 * 3. NO BANNED VOCABULARY. The public copy standard's list — vig, overround,
 *    de-vig, Shin, z-score, Brier, sigma, and the internal names of tables and
 *    functions. A post is public copy like any other surface.
 * 4. THE MODEL NEVER FINDS, DETECTS OR SURFACES A BET. It reads a price. This
 *    is the sentence /how-it-works exists to retract and it must not escape to
 *    the one audience that cannot click through and check.
 * 5. EVERY URL IS A ROUTE THAT EXISTS. Hard-coded from the live route list, not
 *    assembled from a string the caller passes. The previous content guidance
 *    pointed at /feed, /signals, /tips and /accas; of those only a redirect
 *    survives, and /accas was never a route at all — the page is /acca.
 * 6. IT FITS. X counts every URL as 23 characters whatever its length, so the
 *    budget is computed that way rather than on `String.length`.
 */

const SITE = 'https://www.maxedge.live';

/**
 * The only routes this poster may link to. A caller names a KEY, never a path,
 * so a route that is retired breaks the build here rather than shipping a dead
 * link to an audience that will not report it.
 */
const ROUTES = Object.freeze({
  value:       `${SITE}/value-bets`,
  acca:        `${SITE}/acca`,
  stats:       `${SITE}/stats`,
  record:      `${SITE}/performance`,
  pricing:     `${SITE}/pricing`,
  fixtures:    `${SITE}/fixtures`,
  predictions: `${SITE}/predictions`,
});

const FOOTER = '18+ | begambleaware | Pricing analysis, not advice';

/** X counts any URL as this many characters, whatever its real length. */
const URL_WEIGHT = 23;
const MAX_CHARS = 280;

/**
 * The copy standard's banned list, as whole words. `pp` and `sigma` are in it
 * and are short, so the match is word-boundaried rather than substring — a
 * substring test rejects "supported" for containing "pp".
 */
const BANNED = [
  'vig', 'overround', 'de-vig', 'devig', 'shin', 'z-score', 'zscore',
  'brier', 'sigma', 'pp', 'withheld', 'mxs', 'mxs_band', 'value_signals',
  'computed_values', 'posted_signals', 'migration', 'supabase',
];

/** Phrasings that make the model the actor. See rule 4. */
const MODEL_AS_ACTOR = [
  /\bmodel (finds|found|detects|detected|surfaces|surfaced|picks|picked|spots|spotted)\b/i,
  /\b(we|our model) (find|found|detect|detected|surface|surfaced) (a |the )?bets?\b/i,
];

/**
 * Emoji, including the pictographs, dingbats, flags and the variation selector.
 * Deliberately broad: a false positive costs one post, a false negative costs a
 * CAP youth-appeal finding.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

/** The character budget X actually applies. */
function weightedLength(text) {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  let n = [...text].length;
  for (const u of urls) n = n - [...u].length + URL_WEIGHT;
  return n;
}

function hasEmoji(text) { return EMOJI.test(text); }

function bannedWordsIn(text) {
  const lower = text.toLowerCase();
  return BANNED.filter(w => new RegExp(`(^|[^a-z0-9_])${w.replace(/[-]/g, '\\-')}([^a-z0-9_]|$)`, 'i').test(lower));
}

function modelAsActorIn(text) {
  return MODEL_AS_ACTOR.some(re => re.test(text));
}

/** `+8.7%`, one decimal, a real minus. The product's one EV format. */
function formatEv(ev) {
  const pct = Number(ev) * 100;
  if (!Number.isFinite(pct)) return null;
  const sign = pct >= 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function formatOdds(odds) {
  const n = Number(odds);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

class ComposeRefusal extends Error {
  constructor(reason, detail) {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.refusal = reason;
    this.detail = detail ?? null;
  }
}

/**
 * Build a post, or throw. NEVER returns a post that breaks a rule, and never
 * quietly trims one into compliance: a truncated post is a different claim.
 *
 * @param {{ body: string, routeKey: keyof typeof ROUTES }} input
 */
function compose({ body, routeKey }) {
  if (typeof body !== 'string' || !body.trim()) throw new ComposeRefusal('empty-body');
  const url = ROUTES[routeKey];
  if (!url) throw new ComposeRefusal('unknown-route', String(routeKey));

  const text = `${body.trim()}\n\n${url}\n\n${FOOTER}`;

  if (hasEmoji(text)) throw new ComposeRefusal('emoji');
  const banned = bannedWordsIn(body);
  if (banned.length) throw new ComposeRefusal('banned-vocabulary', banned.join(', '));
  if (modelAsActorIn(body)) throw new ComposeRefusal('model-as-actor');

  const len = weightedLength(text);
  if (len > MAX_CHARS) throw new ComposeRefusal('too-long', `${len} > ${MAX_CHARS}`);

  return text;
}

/**
 * SIX PHRASINGS PER POST TYPE, AND THE COUNT IS LOAD-BEARING.
 *
 * `lib/xGuard` refuses a post whose SKELETON — the sentence with every number,
 * club and price removed — has gone out inside its window. Two value posts
 * built from one template have the same skeleton however different the fixture,
 * which is exactly the "substantially similar" pattern X's automation rules
 * prohibit. So the remedy is real phrasing variety, not more data variety, and
 * these are six genuinely different sentence structures rather than six
 * synonym swaps.
 *
 * The guard's window is four. Six variants against a window of four leaves two
 * spare, so one unusable variant does not stop the channel. Cutting this list
 * to four or fewer deadlocks the poster SILENTLY: every candidate refused,
 * nothing sent, no error raised. See the note on SIMILARITY_WINDOW.
 */
function variantsFor(type) {
  return VARIANTS[type]?.length ?? 0;
}

/**
 * The body for a single value bet. It states the price, our read of the price,
 * and nothing about what will happen — the edge is price against price and the
 * post says only that.
 *
 * @param {number} variant index into the six phrasings; wraps.
 */
function valueBody({ home, away, league, selection, odds, ev, book }, variant = 0) {
  const price = formatOdds(odds);
  const edge = formatEv(ev);
  if (!price || !edge) throw new ComposeRefusal('unpriceable');
  const v = VARIANTS.value[((variant % VARIANTS.value.length) + VARIANTS.value.length) % VARIANTS.value.length];
  return v({ home, away, league, selection, price, edge, book });
}

const VARIANTS = {
  value: [
    ({ home, away, league, selection, price, edge, book }) => [
      `${home} v ${away}`,
      league || null,
      '',
      selection,
      `Best price ${price}${book ? ` (${book})` : ''}`,
      `Worth ${edge} against the margin-free line`,
    ].filter(x => x !== null).join('\n'),

    ({ home, away, selection, price, edge, book }) => [
      `Strip the margin out of ${home} v ${away} and ${selection.toLowerCase()} should be shorter than ${price}.`,
      '',
      `${book ? `${book} has it at ` : 'It is available at '}${price}, which is ${edge} of value.`,
    ].join('\n'),

    ({ home, away, league, selection, price, edge }) => [
      `${edge}  ${selection}`,
      '',
      `${home} v ${away}${league ? `, ${league}` : ''}`,
      `Taking ${price} against a fair line that says it should be shorter.`,
    ].join('\n'),

    ({ home, away, selection, price, edge, book }) => [
      `Price check: ${home} v ${away}`,
      '',
      `${selection} at ${price}${book ? ` with ${book}` : ''}.`,
      `Against the market's own margin-free read that is ${edge}.`,
    ].join('\n'),

    ({ league, selection, price, edge }) => [
      `${league || 'Today'} — one price out of line.`,
      '',
      `${selection}, ${price}.`,
      `${edge} once the bookmaker's cut comes off the market's own numbers.`,
    ].join('\n'),

    ({ home, away, selection, price, edge }) => [
      `${home} v ${away}`,
      '',
      `The fair line and the available line disagree on ${selection.toLowerCase()}.`,
      `Available ${price}. The gap is ${edge}.`,
    ].join('\n'),
  ],
};

/** The body for a settled-record post. Outcome, never a forward claim. */
function recordBody({ settled, won, roiPct }) {
  const roi = Number(roiPct);
  const sign = roi >= 0 ? '+' : '−';
  return [
    'The record, settled in public',
    '',
    `${won} of ${settled} picks landed`,
    `${sign}${Math.abs(roi).toFixed(1)}% on level stakes`,
    'Every pick graded against the closing price',
  ].join('\n');
}

/** The body for a base-rate post off /stats. No selection, no price. */
function statBody({ market, league, value, average }) {
  const v = Number(value), a = Number(average);
  const dir = v >= a ? 'above' : 'below';
  return [
    `${league} averages ${v.toFixed(2)} ${market} a match`,
    `The all-competition average is ${a.toFixed(2)}`,
    '',
    `That is ${Math.abs(v - a).toFixed(2)} ${dir} the line most prices are set around`,
  ].join('\n');
}

module.exports = {
  compose, valueBody, recordBody, statBody, variantsFor, VARIANTS,
  weightedLength, hasEmoji, bannedWordsIn, modelAsActorIn, formatEv, formatOdds,
  ComposeRefusal, ROUTES, FOOTER, MAX_CHARS, SITE,
};
