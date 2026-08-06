'use strict';

/**
 * lib/edgeSource.js — WHERE A ROW'S EDGE CAME FROM.
 *
 * The engine twin of eve-frontend/lib/edgeSource.ts. A sibling of
 * lib/publication.js, not a replacement: publication answers "may this
 * architecture make a claim at all", this answers "is this row's edge a market
 * fact or a model opinion". Different questions, different answers — a row can
 * be market-derived and still barred from publishing (MARKET_CONSENSUS is
 * exactly that).
 *
 * WHY IT EXISTS. Under the ruling of 6 Aug 2026 the model may never produce a
 * value flag, an edge number, a price recommendation or a MES score. Enforcing
 * that needs a single place that says which architectures compute an edge by
 * comparing two PRICES, and which compute it by comparing a price to a
 * FORECAST. Everything model-derived is barred from carrying a score.
 *
 * IT FAILS CLOSED. An architecture this file has not heard of is treated as
 * model-derived and scores nothing — the same posture as `isPublished()` and
 * `previewLimit()`. Adding a name to the market side is a claim that no
 * forecast enters its edge at any point.
 */

/** @typedef {'market'|'model'} EdgeSource */

const EDGE_SOURCE = {
  // ── Market-derived: one price measured against another ────────────────────
  MARKET_ANCHORED: {
    source: 'market',
    reason: 'Fair value is Shin-de-vigged Pinnacle; edge is the best bettable price against it. No forecast is involved at any point.',
  },
  MARKET_CONSENSUS: {
    source: 'market',
    reason: 'The de-vigged consensus against the best price — a price-to-price comparison. Market-derived, and separately DISQUALIFIED FROM PUBLISHING by lib/publication.js at -47.0% yield and -24.9% CLV. Edge source and publication are different questions; this passes one and fails the other.',
  },

  // ── Model-derived: a forecast measured against a price ────────────────────
  DIXON_COLES:        { source: 'model', reason: 'edge = modelProb · odds − 1 from a Poisson score matrix.' },
  API_PREDICTIVE:     { source: 'model', reason: 'edge = modelProb · odds − 1 from a five-valued step function of the price.' },
  SUPERMODEL:         { source: 'model', reason: 'edge = modelProb · odds − 1 from the XGBoost forecast.' },
  LAMBDA_MC:          { source: 'model', reason: 'edge = modelProb · odds − 1 from the λ Monte-Carlo price sheet.' },
  SECOND_HALF_SNIPER: { source: 'model', reason: 'edge is a Poisson forecast against a drifted live price.' },
  INPLAY_MODEL:       { source: 'model', reason: 'edge is a live win-probability forecast against the live price.' },
  CORNERS_MODEL:      { source: 'model', reason: 'edge = modelProb · odds − 1 from a corners heuristic.' },
  CARDS_MODEL:        { source: 'model', reason: 'edge = modelProb · odds − 1 from a bookings heuristic.' },
};

/**
 * May this architecture's row carry a score? Fails closed on null and unknown.
 */
function isMarketAnchored(arch) {
  if (arch == null) return false;
  return EDGE_SOURCE[arch] !== undefined && EDGE_SOURCE[arch].source === 'market';
}

/** Why this row carries no score; '' when it does. */
function unscoredReason(arch) {
  if (arch == null) {
    return 'Legacy row with no recorded architecture — its edge cannot be attributed to a price comparison, so it carries no score.';
  }
  const r = EDGE_SOURCE[arch];
  if (!r) return `${arch} is not in the edge-source set, so its edge is treated as model-derived and it carries no score.`;
  return r.source === 'market' ? '' : r.reason;
}

const MARKET_ANCHORED_ARCHITECTURES =
  Object.keys(EDGE_SOURCE).filter(a => EDGE_SOURCE[a].source === 'market');

module.exports = {
  EDGE_SOURCE,
  isMarketAnchored,
  unscoredReason,
  MARKET_ANCHORED_ARCHITECTURES,
};
