/**
 * lib/publication.js — WHICH MODELS MAY REACH A SUBSCRIBER.
 *
 * The engine-side twin of eve-frontend/lib/publication.ts, and the same mirror
 * of `model_calibration.publish` in migration 048. Three copies of one ruling is
 * two too many, but there is no shared package between these repos and the
 * alternative — each surface deciding for itself — is what produced the failure
 * this file exists to stop. Keep all three in step; 048 is the authority.
 *
 * WHY IT EXISTS. The 2026-08-05 audit measured every architecture against the
 * settled record. All 369 signals had been broadcast to Telegram:
 *
 *     MARKET_CONSENSUS   218 posted, 198 settled, yield -47.0%, CLV -24.94%
 *     DIXON_COLES         84 posted,  79 settled, yield  +7.6%, CLV  -0.44%
 *     API_PREDICTIVE      59 posted,  53 settled, yield  -7.2%, CLV -10.33%
 *     corners/cards/none   8 posted,   8 settled, yield  -100%
 *
 * Combined: -98.9 units over 338 settled bets, a -29.3% yield. A subscriber
 * staking a flat £10 since mid-June is down about £990.
 *
 * MARKET_CONSENSUS is the market's own de-vigged price (root Brier 0.3051
 * against the market's 0.3050 — no information added). API_PREDICTIVE emits five
 * distinct probabilities keyed to price bands, 45% applied to home, draw and
 * away alike. And no threshold could have saved either: the training corpus is
 * England-only across 33 seasons, while the published board was Andorran,
 * Estonian, Latvian and Faroese qualifier ties. 191 teams published on, 164 in
 * the corpus, overlap zero.
 *
 * IT FAILS CLOSED. An architecture this file has not heard of does not publish.
 * The bar for adding one is `paper_trade_gate()`: 300 settled bets, CLV above
 * +0.5%, CLV z-score above 2. Yield does not gate it — under a perfectly
 * efficient market there is a 77.63% chance of finding a season that looks
 * significantly biased (Winkelmann et al. 2024), which is exactly what the June
 * 2026 week that looked extraordinary turned out to be: 785% average odds drift
 * and -56% weekly CLV underneath it.
 */
'use strict';

/** Mirrors the `publish` column seeded by migration 048. */
const PUBLICATION = {
  /**
   * MARKET_ANCHORED — ADDED 6 AUG 2026 BY EXPLICIT OWNER DECISION, AND IT DID
   * NOT PASS paper_trade_gate(). See eve-frontend/lib/publication.ts for the
   * full note; the short version is that every other entry here earned its
   * verdict from settled live bets and this one has none.
   *
   * Basis: a backtest over research_dc_preds — 439 gated selections across
   * seven seasons at +11.53%, and +6.58% CLV on flagged against -3.52% on
   * unflagged. Real evidence, and not the evidence this gate asks for (300
   * settled bets, CLV above +0.5%, z above 2). Per-season n is 15-120 with
   * yields swinging -19.4% to +43.7%; Shin actually scored LOWER than the
   * de-vig it replaced (+11.53% vs +17.09%) and was adopted for cutting
   * flagged longshots by 68%, not for a return. Hold it loosely.
   *
   * TO REVERT: flip `publish` to false. The board falls back to a best-price
   * board, which is true whoever computed the row.
   */
  MARKET_ANCHORED:    { publish: true,  reason: 'Published 6 Aug 2026 by owner decision on BACKTEST evidence only — 439 gated selections, +11.53% yield, +6.58% CLV on flagged vs -3.52% unflagged. NO settled live bets; did not pass paper_trade_gate().' },
  DIXON_COLES:        { publish: true,  reason: 'Yield +7.6%, CLV -0.44%, Brier 0.4903 vs market 0.4937 over 77 settled — the only architecture of the five to beat the market.' },
  MARKET_CONSENSUS:   { publish: false, reason: 'Not a model: the de-vigged market price. Brier 0.3051 vs market 0.3050, yield -47.0%, CLV -24.9%.' },
  API_PREDICTIVE:     { publish: false, reason: 'Not a model: five distinct probabilities keyed to price bands, 45% applied to home, draw and away alike.' },
  CORNERS_MODEL:      { publish: false, reason: 'n=4 settled. Under forward measurement in paper_trades; no corner prices exist historically to backtest against.' },
  CARDS_MODEL:        { publish: false, reason: 'n=2 settled. Under forward measurement in paper_trades; no card prices exist historically to backtest against.' },
  SECOND_HALF_SNIPER: { publish: false, reason: 'Anchored on inplay_baseline, which is consensus odds recombined through a Poisson with a fixed offset per outcome.' },
  INPLAY_MODEL:       { publish: false, reason: 'Live 1X2 lambda inverted straight out of the consensus price — the market\'s own number advanced for time and score.' },
  SUPERMODEL:         { publish: false, reason: 'Publishing since 1 Aug 2026 with no settled sample and no measured sigma. Nothing to stand on yet.' },
};

/**
 * May this architecture's output reach a subscriber?
 *
 * A null architecture is a legacy row, which predates every model and is
 * consensus by construction, so it does not publish. Neither does anything
 * absent from the map.
 */
/**
 * IN-PLAY BROADCAST — a DIFFERENT question from `PUBLICATION`, deliberately.
 *
 * WHY THIS EXISTS AT ALL. `fetchRecentSignals` in postToX.js filters every row
 * through `isPublished` before anything else sees it, and no in-play
 * architecture is in `PUBLICATION`. So the `🔴 IN-PLAY` branch that has sat in
 * `buildMessage` since it was written has NEVER been reachable, and would not
 * have become reachable however `TELEGRAM_INPLAY_CHAT_ID` was set — the row
 * was already gone. Three gates were known (RLS, the score trigger, the
 * browser); this is the fourth and it is the one that decided it.
 *
 * WHY IT IS NOT JUST AN ENTRY IN `PUBLICATION`. That table answers "may this
 * model's output be presented as a BACKED SELECTION" — it governs the site,
 * the pre-match channel and the published record. This answers a narrower
 * question: may a live alert go to a DEDICATED, OPT-IN channel that says on
 * every post what it is. Adding INPLAY_DIXON_COLES to `PUBLICATION` would
 * answer the first question too, and the answer to that is still no: it has no
 * `model_calibration` row, no measured error bar, and `performance_summary`
 * keyed 'inplay' has sat at zero settled since it was created.
 *
 * IT IS OFF UNLESS THE OWNER TURNS IT ON. `INPLAY_BROADCAST_ENABLED` is unset
 * by default, so this changes nothing until somebody decides it should — the
 * same shape as INPLAY_WINPROB_ENABLED and SECOND_HALF_SNIPER_ENABLED, and for
 * the same reason: a flag is a decision with a name on it.
 *
 * AND THE POST CARRIES THE DISCLOSURE. Every message this admits states that
 * the architecture is uncalibrated and that its record is empty. That is the
 * condition on which it is admitted at all — if the disclosure is ever removed
 * from `buildMessage`, this set should go with it.
 */
const INPLAY_BROADCAST = {
  INPLAY_DIXON_COLES: {
    label: 'Live win-probability',
    note:  'No measured error bar — no conviction rung, and no settled record yet.',
  },
  SECOND_HALF_SNIPER: {
    label: 'Second-half goals',
    note:  'No measured error bar — no conviction rung, and no settled record yet.',
  },
};

/** Is the in-play channel switched on at all? A decision with a name on it. */
function inplayBroadcastEnabled() {
  return (process.env.INPLAY_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

/**
 * May this architecture reach the dedicated in-play channel?
 *
 * FAILS CLOSED TWICE: off unless the flag is set, and then only for a name in
 * the set above. A new in-play architecture does not inherit this.
 */
function mayBroadcastInplay(arch) {
  if (!inplayBroadcastEnabled()) return false;
  return arch != null && INPLAY_BROADCAST[arch] !== undefined;
}

/** The one-line "what this is" the in-play post prints. Never invented. */
function inplayDisclosure(arch) {
  const r = arch == null ? null : INPLAY_BROADCAST[arch];
  return r ? r.note : 'Uncalibrated in-play model — no measured error bar and no settled record.';
}

/** The reader-facing name for an in-play architecture. Never the raw enum. */
function inplayLabel(arch) {
  const r = arch == null ? null : INPLAY_BROADCAST[arch];
  return r ? r.label : 'In-play model';
}

function isPublished(arch) {
  if (arch == null) return false;
  return PUBLICATION[arch] !== undefined && PUBLICATION[arch].publish === true;
}

/** Architectures that may publish — for building an `.in()` filter. */
const PUBLISHED_ARCHITECTURES = Object.keys(PUBLICATION).filter(a => PUBLICATION[a].publish);

/** Why an architecture is withheld; '' when it publishes. */
function withheldReason(arch) {
  if (arch == null) return 'Legacy row with no recorded architecture — treated as consensus.';
  const r = PUBLICATION[arch];
  if (!r) return `${arch} is not in the calibration set, so it has no measured error.`;
  return r.publish ? '' : r.reason;
}

module.exports = {
  PUBLICATION, PUBLISHED_ARCHITECTURES, isPublished, withheldReason,
  INPLAY_BROADCAST, inplayBroadcastEnabled, mayBroadcastInplay, inplayDisclosure, inplayLabel,
};
