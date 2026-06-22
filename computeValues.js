/**
 * EVE — Value Detection Engine  v5
 *
 * Model: Betfair Exchange as sharp baseline (UK edition)
 *
 * Logic:
 *   1. Use Betfair Exchange (de-vigged) as the "true" probability — the sharpest
 *      price available to UK bettors. Exchange prices reflect real market opinion.
 *   2. If Betfair Exchange not available, fall back to consensus across all books.
 *   3. Find best odds across UK soft books (Sky Bet, Paddy Power, Coral etc).
 *   4. Edge = sharp_prob - implied_prob_from_best_soft_odds
 *   5. Value flag = edge > threshold AND sharp_prob > floor AND odds < cap
 *
 * Why Betfair Exchange:
 *   - Peer-to-peer betting — prices set by the market, not a bookmaker's margin
 *   - Sharpest publicly available price for UK bettors
 *   - Reflects where smart money actually goes in the UK market
 */

'use strict';

const { getClient } = require('./lib/supabaseClient');

const {
  consensusStats, dispersion, confidenceScore, confidenceTier, maxEdgeScore, evForStakes, clamp,
  valueScore, signalTier, bestTier,
} = require('./modelMetrics');

const { computeBookingsModel } = require('./bookingsModel');
const { computeCornersModel }  = require('./cornersModel');
const { buildFeatureVector, MIN_COMPLETENESS } = require('./features');
const { ensembleInference, ensembleAvailable } = require('./ensemble/inference');

// Dixon-Coles structural constants (kept in sync with matchProbabilities)
const DC_BASE = 1.35;
const DC_HOME_ADV = 1.15;

// World Cup 2026 host nations — only these teams get home advantage at the WC.
// Every other World Cup fixture is played on neutral ground (no home edge).
const WC_2026_HOSTS = new Set([
  'USA', 'United States', 'US',
  'Canada',
  'Mexico',
]);

/**
 * Home-advantage multiplier for a fixture.
 * - Club / non-World-Cup football: always 1.15 (real home ground).
 * - World Cup 2026: 1.15 only if the home team is a host nation, else 1.0 (neutral).
 */
function homeAdvFor(match) {
  const isWorldCup = match?.league?.name?.includes('World Cup');
  const homeName = match?.home_team?.name;
  return (!isWorldCup || WC_2026_HOSTS.has(homeName)) ? DC_HOME_ADV : 1.0;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// EV threshold — 2% edge over sharp baseline
const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD ?? '0.02');

// Minimum sharp probability — only flag outcomes the market thinks are likely
// 0.40 = 40%+ chance (2.50 or shorter). Eliminates longshot noise.
const MIN_PROB_FOR_VALUE = parseFloat(process.env.MIN_PROB ?? '0.40');

// Maximum soft book odds — no outsiders
// 2.80 = roughly evens to slight underdog
const MAX_ODDS_FOR_VALUE = parseFloat(process.env.MAX_ODDS ?? '2.80');

// Sharp books — used as baseline in priority order
const SHARP_BOOKS = ['betfair_ex_uk', 'smarkets', 'matchbook'];

// Soft UK books — we find best price across these
const SOFT_BOOKS = new Set([
  'bet365', 'skybet', 'williamhill', 'paddypower', 'coral',
  'ladbrokes_uk', 'betfred_uk', 'betway', 'betvictor',
  'boylesports', 'betfair_sb_uk', 'unibet_uk', 'virginbet',
  'sport888', 'leovegas', 'casumo', 'grosvenor', 'livescorebet',
]);

// ---------------------------------------------------------------------------
// 1. Fetch matches
// ---------------------------------------------------------------------------

async function fetchMatchesForComputation(supabase) {
  const { data, error } = await supabase
    .from('matches')
    .select(`
      id, kickoff_at, status,
      home_team:teams!matches_home_team_id_fkey ( id, name ),
      away_team:teams!matches_away_team_id_fkey ( id, name ),
      league:leagues ( id, name ),
      odds ( bookmaker, market, home_odds, draw_odds, away_odds, market_line, fetched_at )
    `)
    .in('status', ['scheduled', 'live'])
    .order('kickoff_at', { ascending: true });

  if (error) throw new Error(`fetchMatchesForComputation: ${error.message}`);
  return (data ?? []).filter(m => m.odds && m.odds.length > 0);
}

// ---------------------------------------------------------------------------
// 2. De-vig a single set of odds
// ---------------------------------------------------------------------------

function deVig(homeOdds, drawOdds, awayOdds) {
  if (!homeOdds || !drawOdds || !awayOdds) return null;
  if (homeOdds <= 1 || drawOdds <= 1 || awayOdds <= 1) return null;
  const rh = 1 / homeOdds;
  const rd = 1 / drawOdds;
  const ra = 1 / awayOdds;
  const total = rh + rd + ra;
  if (total <= 0) return null;
  return {
    home: rh / total,
    draw: rd / total,
    away: ra / total,
    overround: total,
    margin: ((total - 1) * 100).toFixed(2) + '%',
  };
}

// ---------------------------------------------------------------------------
// 3. Get sharp baseline — Betfair Exchange ONLY (no consensus fallback)
// ---------------------------------------------------------------------------

/**
 * The only acceptable sharp baseline is Betfair Exchange (betfair_ex_uk).
 * If it has not priced this match, return null and the caller skips the match.
 * We deliberately do NOT average other books as a substitute — a consensus of
 * soft books carries their collective margin and is not a true fair price.
 */
function getSharpBaseline(oddsRows) {
  const rows = oddsRows
    .filter(r => r.bookmaker === 'betfair_ex_uk')
    .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at));

  if (!rows.length) return null;

  const row = rows[0];
  const fair = deVig(
    parseFloat(row.home_odds),
    parseFloat(row.draw_odds),
    parseFloat(row.away_odds)
  );
  if (!fair) return null;

  return { ...fair, source: formatBookName('betfair_ex_uk'), isFallback: false };
}

// ---------------------------------------------------------------------------
// 4. Best soft book odds with attribution
// ---------------------------------------------------------------------------

function getBestSoftOdds(oddsRows) {
  const softRows = oddsRows.filter(r => SOFT_BOOKS.has(r.bookmaker));
  if (!softRows.length) {
    // If no soft books, use all non-exchange books
    const allRows = oddsRows.filter(r => !SHARP_BOOKS.includes(r.bookmaker));
    if (!allRows.length) return null;
    return extractBest(allRows);
  }
  return extractBest(softRows);
}

function extractBest(rows) {
  let bestHome = 0, bestDraw = 0, bestAway = 0;
  let homeBook = null, drawBook = null, awayBook = null;
  let latestFetchedAt = null;
  // Per-bookmaker odds maps for betslip intersection engine
  const allHomeOdds = {};
  const allDrawOdds = {};
  const allAwayOdds = {};

  for (const row of rows) {
    const h = parseFloat(row.home_odds);
    const d = parseFloat(row.draw_odds);
    const a = parseFloat(row.away_odds);
    const name = formatBookName(row.bookmaker);
    if (h > 1) allHomeOdds[name] = Math.max(allHomeOdds[name] ?? 0, h);
    if (d > 1) allDrawOdds[name] = Math.max(allDrawOdds[name] ?? 0, d);
    if (a > 1) allAwayOdds[name] = Math.max(allAwayOdds[name] ?? 0, a);
    if (h > bestHome) { bestHome = h; homeBook = row.bookmaker; }
    if (d > bestDraw) { bestDraw = d; drawBook = row.bookmaker; }
    if (a > bestAway) { bestAway = a; awayBook = row.bookmaker; }
    if (!latestFetchedAt || row.fetched_at > latestFetchedAt) {
      latestFetchedAt = row.fetched_at;
    }
  }

  if (!bestHome || !bestDraw || !bestAway) return null;

  return {
    home: bestHome, homeBook: formatBookName(homeBook),
    draw: bestDraw, drawBook: formatBookName(drawBook),
    away: bestAway, awayBook: formatBookName(awayBook),
    fetchedAt: latestFetchedAt,
    allHomeOdds: Object.keys(allHomeOdds).length ? allHomeOdds : null,
    allDrawOdds: Object.keys(allDrawOdds).length ? allDrawOdds : null,
    allAwayOdds: Object.keys(allAwayOdds).length ? allAwayOdds : null,
  };
}

// ---------------------------------------------------------------------------
// Totals (over/under) helpers
// ---------------------------------------------------------------------------

/**
 * De-vigs a two-way over/under market.
 * over_odds stored as home_odds, under_odds stored as away_odds.
 */
function deVigTotals(overOdds, underOdds) {
  if (!overOdds || !underOdds || overOdds <= 1 || underOdds <= 1) return null;
  const ro = 1 / overOdds;
  const ru = 1 / underOdds;
  const total = ro + ru;
  if (total <= 0) return null;
  return { over: ro / total, under: ru / total };
}

/**
 * Sharp totals baseline — Betfair Exchange first, then consensus.
 */
function getSharpTotalsBaseline(totalsRows) {
  for (const sharpKey of SHARP_BOOKS) {
    const rows = totalsRows
      .filter(r => r.bookmaker === sharpKey)
      .sort((a, b) => new Date(b.fetched_at) - new Date(a.fetched_at));
    if (!rows.length) continue;
    const row = rows[0];
    const fair = deVigTotals(parseFloat(row.home_odds), parseFloat(row.away_odds));
    if (fair) return { ...fair, line: parseFloat(row.market_line ?? 0), source: formatBookName(sharpKey) };
  }

  // Consensus fallback
  const fairProbs = totalsRows.map(r => deVigTotals(parseFloat(r.home_odds), parseFloat(r.away_odds))).filter(Boolean);
  if (!fairProbs.length) return null;
  const n = fairProbs.length;
  const over  = fairProbs.reduce((s, p) => s + p.over,  0) / n;
  const under = fairProbs.reduce((s, p) => s + p.under, 0) / n;
  const total = over + under;
  const line  = parseFloat(totalsRows[0]?.market_line ?? 0);
  return { over: over / total, under: under / total, line, source: `Consensus (${n} books)` };
}

/**
 * Best soft totals odds with bookmaker attribution.
 * Falls back to all available totals rows (including exchange) when no soft books have O/U markets.
 */
function getBestSoftTotalsOdds(totalsRows) {
  const softRows = totalsRows.filter(r => SOFT_BOOKS.has(r.bookmaker));
  const nonSharp = totalsRows.filter(r => !SHARP_BOOKS.includes(r.bookmaker));
  const pool = softRows.length ? softRows : nonSharp.length ? nonSharp : totalsRows;
  if (!pool.length) return null;

  let bestOver = 0, bestUnder = 0, overBook = null, underBook = null, latestFetchedAt = null;
  for (const row of pool) {
    const o = parseFloat(row.home_odds);
    const u = parseFloat(row.away_odds);
    if (o > bestOver)  { bestOver  = o; overBook  = row.bookmaker; }
    if (u > bestUnder) { bestUnder = u; underBook = row.bookmaker; }
    if (!latestFetchedAt || row.fetched_at > latestFetchedAt) latestFetchedAt = row.fetched_at;
  }
  if (!bestOver || !bestUnder) return null;
  return { over: bestOver, under: bestUnder, overBook: formatBookName(overBook), underBook: formatBookName(underBook), fetchedAt: latestFetchedAt };
}

// ---------------------------------------------------------------------------
// 5. Bookmaker display names
// ---------------------------------------------------------------------------

function formatBookName(key) {
  if (!key) return null;
  const names = {
    betfair_ex_uk:  'Betfair Exch',
    betfair_sb_uk:  'Betfair SB',
    smarkets:       'Smarkets',
    matchbook:      'Matchbook',
    bet365:         'Bet365',
    skybet:         'Sky Bet',
    williamhill:    'William Hill',
    paddypower:     'Paddy Power',
    coral:          'Coral',
    ladbrokes_uk:   'Ladbrokes',
    betfred_uk:     'Betfred',
    betway:         'Betway',
    betvictor:      'BetVictor',
    boylesports:    'BoyleSports',
    unibet_uk:      'Unibet',
    virginbet:      'Virgin Bet',
    sport888:       '888sport',
    leovegas:       'LeoVegas',
    casumo:         'Casumo',
    grosvenor:      'Grosvenor',
    livescorebet:   'LiveScore Bet',
    pinnacle:       'Pinnacle',
    unibet:         'Unibet',
    betsson:        'Betsson',
  };
  return names[key] ?? key;
}

// ---------------------------------------------------------------------------
// 6. EV and edge
// ---------------------------------------------------------------------------

function computeEdge(sharpProb, bestOdds) {
  if (sharpProb == null || !bestOdds || bestOdds <= 1) return null;
  return parseFloat((sharpProb - (1 / bestOdds)).toFixed(6));
}

function computeEV(sharpProb, bestOdds) {
  if (sharpProb == null || !bestOdds || bestOdds <= 1) return null;
  return parseFloat((sharpProb * bestOdds - 1).toFixed(6));
}

function probToFractional(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  const decimal = 1 / prob;
  if (decimal <= 1) return '1/100';
  const num = Math.round((decimal - 1) * 100);
  const g = gcd(num, 100);
  return `${num / g}/${100 / g}`;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

// ---------------------------------------------------------------------------
// 6b. Dixon-Coles inspired Poisson model — our own AI Prob source
// ---------------------------------------------------------------------------

const TEAM_RATINGS = {
  // Elite
  'France':      { attack: 1.55, defence: 0.65 },
  'Spain':       { attack: 1.50, defence: 0.68 },
  'England':     { attack: 1.45, defence: 0.70 },
  'Brazil':      { attack: 1.50, defence: 0.68 },
  'Argentina':   { attack: 1.55, defence: 0.70 },
  'Portugal':    { attack: 1.45, defence: 0.72 },
  'Germany':     { attack: 1.40, defence: 0.72 },
  'Netherlands': { attack: 1.35, defence: 0.73 },
  'Belgium':     { attack: 1.30, defence: 0.75 },
  'Uruguay':     { attack: 1.25, defence: 0.75 },
  // Strong
  'Colombia':    { attack: 1.25, defence: 0.77 },
  'Mexico':      { attack: 1.20, defence: 0.78 },
  'USA':         { attack: 1.15, defence: 0.80 },
  'Canada':      { attack: 1.10, defence: 0.82 },
  'Switzerland': { attack: 1.15, defence: 0.78 },
  'Croatia':     { attack: 1.15, defence: 0.77 },
  'Japan':       { attack: 1.10, defence: 0.80 },
  'Senegal':     { attack: 1.10, defence: 0.80 },
  'Morocco':     { attack: 1.10, defence: 0.75 },
  'Iran':        { attack: 1.05, defence: 0.82 },
  'South Korea': { attack: 1.10, defence: 0.82 },
  'Australia':   { attack: 1.05, defence: 0.83 },
  'Ecuador':     { attack: 1.05, defence: 0.83 },
  'Turkey':      { attack: 1.10, defence: 0.80 },
  'Norway':      { attack: 1.15, defence: 0.80 },
  'Sweden':      { attack: 1.10, defence: 0.82 },
  'Austria':     { attack: 1.10, defence: 0.82 },
  'Czech Republic': { attack: 1.05, defence: 0.83 },
  'Ivory Coast': { attack: 1.05, defence: 0.83 },
  'Ghana':       { attack: 1.00, defence: 0.85 },
  'Tunisia':     { attack: 1.00, defence: 0.83 },
  'Algeria':     { attack: 1.00, defence: 0.85 },
  'Egypt':       { attack: 1.00, defence: 0.85 },
  'Saudi Arabia':{ attack: 0.95, defence: 0.87 },
  'New Zealand': { attack: 0.90, defence: 0.90 },
  'Paraguay':    { attack: 1.00, defence: 0.85 },
  'Bolivia':     { attack: 0.90, defence: 0.90 },
  'Qatar':       { attack: 0.90, defence: 0.90 },
  'South Africa':{ attack: 0.92, defence: 0.88 },
  'Jordan':      { attack: 0.88, defence: 0.90 },
  'Iraq':        { attack: 0.88, defence: 0.90 },
  'Haiti':       { attack: 0.82, defence: 0.93 },
  'Panama':      { attack: 0.85, defence: 0.90 },
  'Cape Verde':  { attack: 0.88, defence: 0.90 },
  'Uzbekistan':  { attack: 0.90, defence: 0.90 },
  'DR Congo':    { attack: 0.90, defence: 0.88 },
  'Bosnia & Herzegovina': { attack: 0.95, defence: 0.87 },
  'Curaçao':     { attack: 0.75, defence: 0.97 },
  // Default for unknown teams
  'default':     { attack: 0.95, defence: 0.88 },
};

// Common name variants seen in our DB (The Odds API / Betfair spellings)
const TEAM_ALIASES = {
  'turkiye':           'Turkey',
  'czechia':           'Czech Republic',
  'korearepublic':     'South Korea',
  'unitedstates':      'USA',
  'usa':               'USA',
  'bosnia':            'Bosnia & Herzegovina',
  'bosniaherzegovina': 'Bosnia & Herzegovina',
  'iriran':            'Iran',
  'cotedivoire':       'Ivory Coast',
  'drcongo':           'DR Congo',
  'congodr':           'DR Congo',
};

function normTeam(s) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Resolves a DB team name to its rating key, or null if unknown. */
function ratingKeyFor(teamName) {
  if (TEAM_RATINGS[teamName] && teamName !== 'default') return teamName;
  const norm = normTeam(teamName);
  if (TEAM_ALIASES[norm] && TEAM_RATINGS[TEAM_ALIASES[norm]]) return TEAM_ALIASES[norm];
  for (const key of Object.keys(TEAM_RATINGS)) {
    if (key === 'default') continue;
    if (normTeam(key) === norm) return key;
  }
  return null;
}

/** True if the team has explicit ratings (not falling back to default). */
function isRated(teamName) {
  return ratingKeyFor(teamName) !== null;
}

/** Resolves a DB team name to its rating, tolerating spelling/accents. */
function ratingFor(teamName) {
  const key = ratingKeyFor(teamName);
  return key ? TEAM_RATINGS[key] : TEAM_RATINGS['default'];
}

/** Poisson PMF: P(X=k) for X ~ Poisson(lambda), computed in log-space. */
function poisson(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// ---------------------------------------------------------------------------
// P2-3: Concurrency pool size for computeMatch batching
// ---------------------------------------------------------------------------

/**
 * Maximum number of matches processed concurrently in the main run() loop.
 * Each computeMatch call fires 6 parallel DB queries (buildFeatureVector) so
 * at COMPUTE_CONCURRENCY=5 the steady-state DB load is ~30 concurrent queries —
 * well within Supabase's PgBouncer connection pool limits.
 */
const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY ?? '5', 10);

/**
 * Executes `fn` over `items` with at most `concurrency` items in-flight at once.
 * Uses chunk-based batching: awaits each full chunk before starting the next.
 * This provides a strict upper bound on concurrent DB connections.
 *
 * Each item's `fn` is expected to handle its own errors and return null on
 * failure. An unhandled throw from `fn` propagates to the chunk's Promise.all
 * and surfaces as a fatal error for the entire run (fail-fast semantics).
 *
 * @template T
 * @template R
 * @param {T[]}                    items
 * @param {function(T): Promise<R>} fn
 * @param {number}                 concurrency
 * @returns {Promise<Array<R>>}
 */
async function withPool(items, fn, concurrency) {
  if (concurrency < 1) throw new RangeError(`COMPUTE_CONCURRENCY must be >= 1, got ${concurrency}`);
  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const chunk = items.slice(start, start + concurrency);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// P2-8: Multi-tiered temperature sharpening
// ---------------------------------------------------------------------------

/**
 * Sharpness calibration: the raw Dixon-Coles output systematically UNDER-rates
 * favourites vs the market. Temperature sharpening (s > 1) pushes probability
 * mass toward the favourite so the model is centred on the exchange — genuine
 * disagreements then occur in BOTH directions, enabling Ruby signals.
 *
 * Two tiers are necessary because single-book markets have noisier fair-price
 * estimates (one soft-book price carries its margin unchallenged) so the same
 * sharpening factor over-corrects relative to a multi-book consensus.
 *
 * Calibrated by calibrate.js against Betfair-implied probabilities:
 *   SHARPNESS_MULTI_BOOK  (softCount >= MULTI_BOOK_THRESHOLD) — fitted on the
 *     market segment with the most reliable edge estimates (3+ independent
 *     soft prices anchoring the best-odds composite).
 *   SHARPNESS_SINGLE_BOOK (softCount < MULTI_BOOK_THRESHOLD)  — fitted on the
 *     thinner market segment; a lower value is expected because a single-book
 *     price carries more margin noise and a tighter sharpening over-penalises
 *     the favourite.
 *
 * Override both via env vars after running calibrate.js to get the latest sweep.
 * MODEL_SHARPNESS is kept as a backward-compatibility alias for the multi-book tier.
 */
const SHARPNESS_MULTI_BOOK  = parseFloat(
  process.env.SHARPNESS_MULTI_BOOK ?? process.env.MODEL_SHARPNESS ?? '1.7',
);
const SHARPNESS_SINGLE_BOOK = parseFloat(process.env.SHARPNESS_SINGLE_BOOK ?? '1.0');
const MULTI_BOOK_THRESHOLD  = parseInt(process.env.MULTI_BOOK_THRESHOLD ?? '3', 10);

/**
 * Dixon-Coles inspired 1X2 probabilities from team attack/defence ratings,
 * with optional temperature sharpening. Returns { home, draw, away } summing to 1.
 */
function matchProbabilities(homeTeam, awayTeam, sharpness = SHARPNESS_MULTI_BOOK, homeAdv = DC_HOME_ADV) {
  const home = ratingFor(homeTeam);
  const away = ratingFor(awayTeam);
  const BASE = 1.35, MAX_GOALS = 7;

  const lambdaHome = BASE * home.attack * away.defence * homeAdv;
  const lambdaAway = BASE * away.attack * home.defence;

  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poisson(i, lambdaHome) * poisson(j, lambdaAway);
      if (i > j) homeWin += p;
      else if (i === j) draw += p;
      else awayWin += p;
      if (i >= 1 && j >= 1) bttsYes += p;
    }
  }

  let h = homeWin, d = draw, a = awayWin;
  const total = h + d + a;
  h /= total; d /= total; a /= total;

  if (sharpness !== 1) {
    const ph = Math.pow(h, sharpness), pd = Math.pow(d, sharpness), pa = Math.pow(a, sharpness);
    const t = ph + pd + pa;
    return { home: ph / t, draw: pd / t, away: pa / t, bttsYes };
  }
  return { home: h, draw: d, away: a, bttsYes };
}

// ---------------------------------------------------------------------------
// 7. Per-match computation
// ---------------------------------------------------------------------------

async function computeMatch(match, supabase = null) {
  const homeStr = match.home_team?.name ?? 'Home';
  const awayStr = match.away_team?.name ?? 'Away';

  if (!match.odds || match.odds.length < 1) {
    console.warn(`  [skip] ${homeStr} vs ${awayStr}: no odds`);
    return null;
  }

  // Split odds by market
  const h2hOdds      = match.odds.filter(r => (r.market ?? 'h2h') === 'h2h');
  const totalsOdds   = match.odds.filter(r => r.market === 'totals');
  const bttsOdds     = match.odds.filter(r => r.market === 'btts');
  const bookingsOdds = match.odds.filter(r => r.market === 'bookings');
  const cornersOdds  = match.odds.filter(r => r.market === 'corners');

  const h2hPool = h2hOdds.length ? h2hOdds : match.odds;

  // The Dixon-Coles ratings table only covers the 2026 World Cup. For matches
  // where neither team is rated (e.g. domestic league fixtures), both teams
  // fall back to the same default and the model produces meaningless, identical
  // probabilities — so skip rather than emit noise edges.
  if (!isRated(homeStr) && !isRated(awayStr)) {
    console.warn(`  [skip] ${homeStr} vs ${awayStr}: no model ratings (non-World-Cup fixture)`);
    return null;
  }

  // Home advantage: full for club football, but at the World Cup only host
  // nations (USA/Canada/Mexico) play "at home" — everyone else is on neutral turf.
  const homeAdvMultiplier = homeAdvFor(match);
  const isWorldCup = match.league?.name?.includes('World Cup');
  console.log(`    [home-adv] ${homeStr} vs ${awayStr}: ${homeAdvMultiplier > 1 ? `APPLIED x${homeAdvMultiplier}` : 'NEUTRAL (x1.0)'}${isWorldCup ? ' [World Cup]' : ''}`);

  // P2-8: Soft book coverage count must be known BEFORE the model so that the
  // correct sharpness tier can be injected into the Dixon-Coles fallback. A
  // single-book market has a noisier fair-price estimate (the soft margin is
  // unchallenged) — applying the multi-book sharpness over-corrects it.
  const softBookCount = new Set(
    h2hPool.filter(r => SOFT_BOOKS.has(r.bookmaker)).map(r => r.bookmaker)
  ).size;

  if (softBookCount < 1) {
    console.warn(`  [skip] ${homeStr} vs ${awayStr}: no soft book coverage`);
    return null;
  }

  // Select sharpness tier based on how many independent soft prices anchor the
  // best-odds composite. With 3+ books the margin noise averages out; below
  // MULTI_BOOK_THRESHOLD a single book's spread may dominate the composite.
  const effectiveSharpness = softBookCount >= MULTI_BOOK_THRESHOLD
    ? SHARPNESS_MULTI_BOOK
    : SHARPNESS_SINGLE_BOOK;

  // Model probability — try ML Ensemble first, fall back to Dixon-Coles Poisson.
  let model;
  let modelArchitecture = 'DIXON_COLES';
  let featureCompleteness = null;

  try {
    if (supabase && ensembleAvailable()) {
      const fv = await buildFeatureVector(supabase, match);
      if (fv) {
        featureCompleteness = fv.completeness;
        const ensembleResult = await ensembleInference(fv.features, fv.completeness, MIN_COMPLETENESS);
        if (ensembleResult) {
          model = {
            home:    ensembleResult.home,
            draw:    ensembleResult.draw,
            away:    ensembleResult.away,
            bttsYes: ensembleResult.btts ?? null,
            overProb: ensembleResult.over ?? null,
          };
          modelArchitecture = 'ML_ENSEMBLE';
          console.log(`    [ensemble] ${homeStr} vs ${awayStr}: H=${(model.home*100).toFixed(0)}% D=${(model.draw*100).toFixed(0)}% A=${(model.away*100).toFixed(0)}% (completeness ${(featureCompleteness*100).toFixed(0)}%)`);
        }
      }
    }
  } catch (err) {
    console.warn(`    [ensemble] error, falling back to Dixon-Coles: ${err.message}`);
  }

  if (!model) {
    const sharpnessTier = softBookCount >= MULTI_BOOK_THRESHOLD ? 'multi' : 'single';
    model = matchProbabilities(homeStr, awayStr, effectiveSharpness, homeAdvMultiplier);
    console.log(`    [dixon-coles] ${homeStr} vs ${awayStr}: H=${(model.home*100).toFixed(0)}% D=${(model.draw*100).toFixed(0)}% A=${(model.away*100).toFixed(0)}% (s=${effectiveSharpness.toFixed(1)} tier=${sharpnessTier} books=${softBookCount})`);
  }

  // Best soft odds (h2h)
  const soft = getBestSoftOdds(h2hPool);
  if (!soft) {
    console.warn(`  [skip] ${homeStr} vs ${awayStr}: no soft book odds`);
    return null;
  }

  // Betfair Exchange sanity check — not the baseline, just a guardrail.
  // If the exchange disagrees with our model by >20pp on any outcome, warn.
  const betfair = getSharpBaseline(h2hPool); // returns null if no exchange odds
  if (betfair) {
    const diffs = {
      home: Math.abs(model.home - betfair.home),
      draw: Math.abs(model.draw - betfair.draw),
      away: Math.abs(model.away - betfair.away),
    };
    const maxDiff = Math.max(diffs.home, diffs.draw, diffs.away);
    if (maxDiff > 0.20) {
      console.warn(`    [check] ${homeStr} vs ${awayStr}: model vs Betfair differ by ${(maxDiff * 100).toFixed(0)}pp (model H:${(model.home*100).toFixed(0)} D:${(model.draw*100).toFixed(0)} A:${(model.away*100).toFixed(0)} | bf H:${(betfair.home*100).toFixed(0)} D:${(betfair.draw*100).toFixed(0)} A:${(betfair.away*100).toFixed(0)}) — using model`);
    }
  }

  // Fair odds strings for display (from our model)
  const fairOdds = {
    home: probToFractional(model.home),
    draw: probToFractional(model.draw),
    away: probToFractional(model.away),
  };

  // Edge = model probability − implied probability from best soft odds
  const homeEdge = computeEdge(model.home, soft.home);
  const drawEdge = computeEdge(model.draw, soft.draw);
  const awayEdge = computeEdge(model.away, soft.away);

  if (homeEdge == null || drawEdge == null || awayEdge == null) {
    console.warn(`  [skip] ${homeStr} vs ${awayStr}: edge failed`);
    return null;
  }

  const homeEV = computeEV(model.home, soft.home);
  const drawEV = computeEV(model.draw, soft.draw);
  const awayEV = computeEV(model.away, soft.away);

  // Value flags — all three conditions required
  const homeValue = homeEV != null && homeEV > EV_THRESHOLD
    && model.home >= MIN_PROB_FOR_VALUE
    && soft.home <= MAX_ODDS_FOR_VALUE;
  const drawValue = drawEV != null && drawEV > EV_THRESHOLD
    && model.draw >= MIN_PROB_FOR_VALUE
    && soft.draw <= MAX_ODDS_FOR_VALUE;
  const awayValue = awayEV != null && awayEV > EV_THRESHOLD
    && model.away >= MIN_PROB_FOR_VALUE
    && soft.away <= MAX_ODDS_FOR_VALUE;

  const positiveEdges = [homeEdge, drawEdge, awayEdge].filter(e => e != null && e > 0);
  const maxEdge = positiveEdges.length > 0 ? Math.max(...positiveEdges) : null;
  const hasValue = homeValue || drawValue || awayValue;

  // ── Totals ──────────────────────────────────────────────────────────────
  let totalsResult = {};
  if (totalsOdds.length > 0) {
    const sharpTotals = getSharpTotalsBaseline(totalsOdds);
    const softTotals  = sharpTotals ? getBestSoftTotalsOdds(totalsOdds) : null;

    if (sharpTotals && softTotals) {
      const overEdge  = computeEdge(sharpTotals.over,  softTotals.over);
      const underEdge = computeEdge(sharpTotals.under, softTotals.under);
      const overEV    = computeEV(sharpTotals.over,  softTotals.over);
      const underEV   = computeEV(sharpTotals.under, softTotals.under);

      const overValue  = overEV != null && overEV > EV_THRESHOLD
        && sharpTotals.over  >= MIN_PROB_FOR_VALUE && softTotals.over  <= MAX_ODDS_FOR_VALUE;
      const underValue = underEV != null && underEV > EV_THRESHOLD
        && sharpTotals.under >= MIN_PROB_FOR_VALUE && softTotals.under <= MAX_ODDS_FOR_VALUE;

      console.log(`    totals line=${sharpTotals.line} O:${(sharpTotals.over*100).toFixed(0)}% U:${(sharpTotals.under*100).toFixed(0)}% overEdge=${overEdge != null ? (overEdge*100).toFixed(1)+'%' : '?'} ${overValue||underValue ? '✓ TOTALS VALUE' : ''}`);

      totalsResult = {
        over_odds:   softTotals.over,
        under_odds:  softTotals.under,
        over_book:   softTotals.overBook,
        under_book:  softTotals.underBook,
        over_edge:   overEdge,
        under_edge:  underEdge,
        over_value:  overValue,
        under_value: underValue,
        totals_line: sharpTotals.line,
      };
    }
  }

  // ── BTTS ────────────────────────────────────────────────────────────────────
  let bttsResult = {};
  // Always store the model probability so the UI can show it even before odds flow in
  if (model.bttsYes != null) {
    bttsResult.btts_model_prob = model.bttsYes;
  }
  if (bttsOdds.length > 0 && model.bttsYes != null) {
    const modelBttsYes = model.bttsYes;
    const modelBttsNo  = 1 - modelBttsYes;

    // Build per-bookmaker BTTS odds maps
    const allBttsYesOdds = {}, allBttsNoOdds = {};
    for (const r of bttsOdds) {
      const name = formatBookName(r.bookmaker);
      const y = parseFloat(r.home_odds), n = parseFloat(r.away_odds);
      if (y > 1) allBttsYesOdds[name] = Math.max(allBttsYesOdds[name] ?? 0, y);
      if (n > 1) allBttsNoOdds[name]  = Math.max(allBttsNoOdds[name] ?? 0, n);
    }

    // Best soft-book BTTS odds (yes → home_odds, no → away_odds per betfairIngest convention)
    const softBtts = bttsOdds.filter(r => SOFT_BOOKS.has(r.bookmaker));
    const bttsSrc  = softBtts.length ? softBtts : bttsOdds;
    let bestYesOdds = 0, bestNoOdds = 0, bestYesBook = null, bestNoBook = null;
    for (const r of bttsSrc) {
      const y = parseFloat(r.home_odds), n = parseFloat(r.away_odds);
      if (y > bestYesOdds) { bestYesOdds = y; bestYesBook = formatBookName(r.bookmaker); }
      if (n > bestNoOdds)  { bestNoOdds  = n; bestNoBook  = formatBookName(r.bookmaker); }
    }

    if (bestYesOdds > 1 && bestNoOdds > 1) {
      const yesEdge = computeEdge(modelBttsYes, bestYesOdds);
      const noEdge  = computeEdge(modelBttsNo,  bestNoOdds);
      const yesValue = yesEdge != null && yesEdge > 0 && bestYesOdds <= MAX_ODDS_FOR_VALUE;
      const noValue  = noEdge  != null && noEdge  > 0 && bestNoOdds  <= MAX_ODDS_FOR_VALUE;
      console.log(`    btts Y:${bestYesOdds}(${bestYesBook}) N:${bestNoOdds}(${bestNoBook}) modelYes:${(modelBttsYes*100).toFixed(0)}% edge:${yesEdge != null ? (yesEdge*100).toFixed(1)+'%' : '?'} ${yesValue||noValue ? '✓ BTTS VALUE' : ''}`);
      bttsResult = {
        btts_yes_odds:      bestYesOdds,
        btts_no_odds:       bestNoOdds,
        btts_yes_book:      bestYesBook,
        btts_no_book:       bestNoBook,
        btts_yes_edge:      yesEdge,
        btts_no_edge:       noEdge,
        btts_yes_value:     yesValue,
        btts_no_value:      noValue,
        btts_model_prob:    modelBttsYes,
        all_btts_yes_odds:  Object.keys(allBttsYesOdds).length ? allBttsYesOdds : null,
        all_btts_no_odds:   Object.keys(allBttsNoOdds).length  ? allBttsNoOdds  : null,
      };
    }
  }

  // ── Bookings (card points) ──────────────────────────────────────────────────
  let bookingsResult = {};
  if (bookingsOdds.length > 0) {
    // Pick the most liquid line (lowest overround)
    let best = null, bestSpread = Infinity;
    for (const r of bookingsOdds) {
      const o = parseFloat(r.home_odds), u = parseFloat(r.away_odds);
      if (!o || !u || o <= 1 || u <= 1) continue;
      const spread = Math.abs((1 / o + 1 / u) - 1);
      if (spread < bestSpread) {
        bestSpread = spread;
        best = { over: o, under: u, line: parseFloat(r.market_line ?? 0) };
      }
    }
    if (best) {
      const isNeutral = match.league?.name?.includes('World Cup') ?? true;
      const bm = computeBookingsModel(homeStr, awayStr, isNeutral, best.line);
      const overEdge  = computeEdge(bm.probOver,  best.over);
      const underEdge = computeEdge(bm.probUnder, best.under);
      const overValue  = overEdge  != null && overEdge  > 0 && best.over  <= MAX_ODDS_FOR_VALUE;
      const underValue = underEdge != null && underEdge > 0 && best.under <= MAX_ODDS_FOR_VALUE;
      console.log(`    bookings line=${best.line} O:${best.over} U:${best.under} modelOver:${(bm.probOver*100).toFixed(0)}% lambda:${bm.lambda.toFixed(1)} ${overValue||underValue ? '✓ CARDS VALUE' : ''}`);
      bookingsResult = {
        bookings_over_odds:   best.over,
        bookings_under_odds:  best.under,
        bookings_line:        best.line,
        bookings_over_edge:   overEdge,
        bookings_under_edge:  underEdge,
        bookings_over_value:  overValue,
        bookings_under_value: underValue,
        bookings_model_prob:  bm.probOver,
        bookings_lambda:      parseFloat(bm.lambda.toFixed(2)),
      };
    }
  }

  // ── Corners ─────────────────────────────────────────────────────────────────
  let cornersResult = {};
  if (cornersOdds.length > 0) {
    let best = null, bestSpread = Infinity;
    for (const r of cornersOdds) {
      const o = parseFloat(r.home_odds), u = parseFloat(r.away_odds);
      if (!o || !u || o <= 1 || u <= 1) continue;
      const spread = Math.abs((1 / o + 1 / u) - 1);
      if (spread < bestSpread) {
        bestSpread = spread;
        best = { over: o, under: u, line: parseFloat(r.market_line ?? 0) };
      }
    }
    if (best) {
      const isNeutral = match.league?.name?.includes('World Cup') ?? true;
      const cm = computeCornersModel(homeStr, awayStr, isNeutral, best.line);
      const overEdge  = computeEdge(cm.probOver,  best.over);
      const underEdge = computeEdge(cm.probUnder, best.under);
      const overValue  = overEdge  != null && overEdge  > 0 && best.over  <= MAX_ODDS_FOR_VALUE;
      const underValue = underEdge != null && underEdge > 0 && best.under <= MAX_ODDS_FOR_VALUE;
      console.log(`    corners line=${best.line} O:${best.over} U:${best.under} modelOver:${(cm.probOver*100).toFixed(0)}% lambda:${cm.lambda.toFixed(1)} ${overValue||underValue ? '✓ CORNERS VALUE' : ''}`);
      cornersResult = {
        corners_over_odds:   best.over,
        corners_under_odds:  best.under,
        corners_line:        best.line,
        corners_over_edge:   overEdge,
        corners_under_edge:  underEdge,
        corners_over_value:  overValue,
        corners_under_value: underValue,
        corners_model_prob:  cm.probOver,
        corners_lambda:      parseFloat(cm.lambda.toFixed(2)),
      };
    }
  }

  // ── Professional metrics layer (Features #2 #3 #4 #5 #8) ─────────────────
  const softRows = h2hPool.filter(r => SOFT_BOOKS.has(r.bookmaker));
  const consensus = consensusStats(softRows, model);

  // Identify the headline (max-edge) outcome.
  const edgeByOutcome = { home: homeEdge, draw: drawEdge, away: awayEdge };
  const bestOutcome = ['home', 'draw', 'away']
    .reduce((a, b) => (edgeByOutcome[b] > edgeByOutcome[a] ? b : a), 'home');
  const bestModelProb = model[bestOutcome];
  const bestOdds      = soft[bestOutcome];
  const bestEdge      = edgeByOutcome[bestOutcome];

  // Confidence inputs (live where possible, neutral placeholders otherwise).
  const bookCount = new Set(softRows.map(r => r.bookmaker)).size;
  const hasExchange = h2hPool.some(r => r.bookmaker === 'betfair_ex_uk');
  const liquidity = clamp(bookCount / 12 + (hasExchange ? 0.1 : 0), 0, 1);
  const cv = dispersion(softRows, bestOutcome);
  const consensusTightness = clamp(1 - cv / 0.15, 0, 1);
  const marketAgreement = betfair
    ? clamp(1 - Math.abs(bestModelProb - betfair[bestOutcome]) / 0.25, 0, 1)
    : 0.6; // no exchange → neutral-ish
  const HIST_ACCURACY = 0.5;   // placeholder until CLV history accrues
  const LINE_STABILITY = 0.5;  // placeholder until odds snapshots accrue

  const confidence = confidenceScore({
    edgePct: bestEdge, marketAgreement, liquidity,
    consensusTightness, histAccuracy: HIST_ACCURACY, lineStability: LINE_STABILITY,
  });
  const tier = confidenceTier(confidence);

  // Max Edge Score
  const consensusDisagreement = consensus[bestOutcome]
    ? clamp((consensus[bestOutcome].topBookPct ?? 0) / 10, 0, 1) : 0;
  const mesResult = maxEdgeScore({
    edgePct: bestEdge, confidence, consensusDisagreement, liquidity, clv: 0.5,
  });
  const mes = mesResult.score;

  // Expected value per stake for the headline outcome
  const ev = evForStakes(bestModelProb, bestOdds, [10, 50, 100]);

  // Explainability (#8) — decompose the Dixon-Coles goal expectations
  // (uses the same home-advantage multiplier the model actually applied).
  const hr = ratingFor(homeStr), ar = ratingFor(awayStr);
  const lambdaHome = DC_BASE * hr.attack * ar.defence * homeAdvMultiplier;
  const lambdaAway = DC_BASE * ar.attack * hr.defence;
  const explain = {
    homeXG: +lambdaHome.toFixed(2),
    awayXG: +lambdaAway.toFixed(2),
    factors: [
      { label: 'Attack rating',   home: hr.attack,  away: ar.attack },
      { label: 'Defence rating',  home: hr.defence, away: ar.defence },
      { label: 'Home advantage',  note: homeAdvMultiplier > 1 ? `+${Math.round((homeAdvMultiplier - 1) * 100)}% to ${homeStr} xG` : 'Neutral venue (World Cup)' },
      { label: 'Recent form',     status: 'planned' },
      { label: 'Injuries',        status: 'planned' },
    ],
  };

  // ── Ruby / signal-tier premium layer (per outcome) ───────────────────────
  const vsHome = valueScore(homeEdge, model.home);
  const vsDraw = valueScore(drawEdge, model.draw);
  const vsAway = valueScore(awayEdge, model.away);

  const tierHome = signalTier(homeEdge, model.home, vsHome);
  const tierDraw = signalTier(drawEdge, model.draw, vsDraw);
  const tierAway = signalTier(awayEdge, model.away, vsAway);

  const homeRuby = tierHome === 'RUBY';
  const drawRuby = tierDraw === 'RUBY';
  const awayRuby = tierAway === 'RUBY';
  const signal_tier = bestTier([tierHome, tierDraw, tierAway]);

  if (signal_tier === 'RUBY') {
    const which = [homeRuby && 'HOME', drawRuby && 'DRAW', awayRuby && 'AWAY'].filter(Boolean).join('/');
    console.log(`    ◆ RUBY signal: ${which}`);
  }

  const metrics = {
    confidence_score: confidence,
    confidence_tier:  tier,
    max_edge_score:   mes,
    mes_breakdown:    mesResult.breakdown,
    best_outcome:     bestOutcome,
    ev_per_unit:      ev.evPerUnit,
    consensus,
    explain,
    home_value_score: vsHome,
    draw_value_score: vsDraw,
    away_value_score: vsAway,
    home_ruby:        homeRuby,
    draw_ruby:        drawRuby,
    away_ruby:        awayRuby,
    signal_tier,
  };

  const probStr = `H:${(model.home*100).toFixed(0)}% D:${(model.draw*100).toFixed(0)}% A:${(model.away*100).toFixed(0)}%`;
  console.log(`  ${homeStr} vs ${awayStr} | ${probStr} | src:${modelArchitecture} | edge:${maxEdge != null ? (maxEdge*100).toFixed(1)+'%' : 'none'} | conf:${confidence}(${tier}) | MES:${mes} ${hasValue ? '✓ VALUE' : ''}`);

  return {
    match_id:        match.id,
    best_home_odds:  soft.home,
    best_draw_odds:  soft.draw,
    best_away_odds:  soft.away,
    best_home_book:  soft.homeBook,
    best_draw_book:  soft.drawBook,
    best_away_book:  soft.awayBook,
    all_home_odds:   soft.allHomeOdds ?? null,
    all_draw_odds:   soft.allDrawOdds ?? null,
    all_away_odds:   soft.allAwayOdds ?? null,
    fair_home_odds:  fairOdds.home,
    fair_draw_odds:  fairOdds.draw,
    fair_away_odds:  fairOdds.away,
    home_edge:       homeEdge,
    draw_edge:       drawEdge,
    away_edge:       awayEdge,
    home_value:      homeValue,
    draw_value:      drawValue,
    away_value:      awayValue,
    odds_fetched_at: soft.fetchedAt,
    computed_at:     new Date().toISOString(),
    ...totalsResult,
    ...bttsResult,
    ...bookingsResult,
    ...cornersResult,
    ...metrics,
    model_architecture:   modelArchitecture,
    feature_completeness: featureCompleteness,
    _maxEdge:        maxEdge,
    _homeEV:         homeEV,
    _drawEV:         drawEV,
    _awayEV:         awayEV,
    _model:          model,
    _kickoff_at:     match.kickoff_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// 8. Database writes
// ---------------------------------------------------------------------------

/**
 * Upserts computed values and returns the current signals_written state for
 * every row so the caller can apply the P2-5 checkpoint without a second query.
 *
 * `signals_written` is intentionally excluded from the payload — PostgREST only
 * includes columns present in the object in its ON CONFLICT DO UPDATE SET clause,
 * so the existing `true` value is preserved on conflict (not reset to false).
 * New inserts receive the column DEFAULT (false) automatically.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} rows
 * @returns {Promise<Map<string, boolean>>} match_id → signals_written
 */
async function upsertComputedValues(supabase, rows) {
  if (!rows.length) return new Map();

  const dbRows = rows.map(row => {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      // Strip internal-only properties (prefixed _) and the checkpoint column
      // so that signals_written is preserved on conflict rather than overwritten.
      if (!k.startsWith('_') && k !== 'signals_written') clean[k] = v;
    }
    return clean;
  });

  const { data, error } = await supabase
    .from('computed_values')
    .upsert(dbRows, { onConflict: 'match_id' })
    .select('match_id, signals_written');

  if (error) throw new Error(`upsertComputedValues: ${error.message}`);

  return new Map((data ?? []).map(r => [r.match_id, r.signals_written === true]));
}

// ---------------------------------------------------------------------------
// 8b. CLV foundation — record every value signal EVE detects
// ---------------------------------------------------------------------------

/**
 * For each match with a flagged value outcome (home/draw/away), record a row in
 * value_signals — UNLESS an identical match_id + outcome signal was already
 * detected within the last 2 hours (in which case we skip to avoid duplicating
 * the same live signal on every 10-minute run).
 *
 * This builds a permanent historical record of every value signal, which later
 * lets us join closing odds and compute CLV (closing line value).
 */
async function insertValueSignals(supabase, rows) {
  // 1. Collect every (match_id, outcome) currently flagged as value.
  const candidates = [];
  for (const row of rows) {
    const flagged = { home: row.home_value, draw: row.draw_value, away: row.away_value };
    for (const outcome of ['home', 'draw', 'away']) {
      if (!flagged[outcome]) continue;
      candidates.push({
        match_id:      row.match_id,
        outcome,
        detected_odds: row[`best_${outcome}_odds`],   // best soft odds for this outcome
        detected_edge: row[`${outcome}_edge`],
        detected_mes:  row.max_edge_score ?? null,
        bookmaker:     row[`best_${outcome}_book`],    // best book for this outcome
        kickoff_at:    row._kickoff_at ?? null,
      });
    }
  }
  if (!candidates.length) {
    console.log('[value_signals] no value outcomes to record');
    return 0;
  }

  // 2. Find signals already recorded for these matches in the last 2 hours.
  const matchIds = [...new Set(candidates.map(c => c.match_id))];
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: selErr } = await supabase
    .from('value_signals')
    .select('match_id, outcome')
    .in('match_id', matchIds)
    .gte('detected_at', twoHoursAgo);
  if (selErr) throw new Error(`insertValueSignals(select): ${selErr.message}`);

  const seen = new Set((recent ?? []).map(r => `${r.match_id}|${r.outcome}`));

  // 3. Insert only the signals not already seen in the window.
  const toInsert = candidates.filter(c => !seen.has(`${c.match_id}|${c.outcome}`));
  if (!toInsert.length) {
    console.log(`[value_signals] all ${candidates.length} signal(s) already recorded within 2h — skipping`);
    return 0;
  }

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);
  console.log(`[value_signals] recorded ${toInsert.length} new signal(s) (${candidates.length - toInsert.length} skipped as duplicates within 2h)`);
  return toInsert.length;
}

async function updateBetOfDay(supabase, rows) {
  const candidates = rows.filter(r => r._maxEdge != null && r._maxEdge > 0);
  if (!candidates.length) {
    await supabase.from('matches').update({ is_bet_of_day: false }).eq('is_bet_of_day', true);
    return null;
  }
  const winner = candidates.reduce((a, b) => b._maxEdge > a._maxEdge ? b : a);

  // Clear all first, then set winner — avoids unique constraint conflict
  await supabase.from('matches').update({ is_bet_of_day: false })
    .eq('is_bet_of_day', true).neq('id', winner.match_id);
  const { error } = await supabase
    .from('matches').update({ is_bet_of_day: true }).eq('id', winner.match_id);
  if (error) throw new Error(`updateBetOfDay: ${error.message}`);

  console.log(`[BOTD] ${winner.match_id} max_edge=${(winner._maxEdge*100).toFixed(1)}%`);
  return winner.match_id;
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\n[engine v5 — UK exchange baseline] ${new Date().toISOString()}`);
  const supabase = getClient();

  let matches;
  try {
    matches = await fetchMatchesForComputation(supabase);
    console.log(`[engine] ${matches.length} matches with odds`);
  } catch (err) {
    console.error('[engine] fatal:', err.message);
    process.exit(1);
  }

  if (!matches.length) {
    console.log('[engine] nothing to process');
    return { processed: 0, skipped: 0, botd: null };
  }

  // P2-3: Concurrency-limited pool — processes up to COMPUTE_CONCURRENCY matches
  // simultaneously instead of serially. Each computeMatch fires 6 parallel
  // buildFeatureVector queries, so the steady-state DB load at concurrency=5 is
  // ~30 concurrent queries — within Supabase's PgBouncer limits.
  console.log(`[engine] processing ${matches.length} match(es) (pool=${COMPUTE_CONCURRENCY})`);

  const allResults = await withPool(
    matches,
    async (match) => {
      try {
        return await computeMatch(match, supabase);
      } catch (err) {
        console.error(`[engine] error match=${match.id}: ${err.message}`);
        return null;
      }
    },
    COMPUTE_CONCURRENCY,
  );

  const rows    = allResults.filter(Boolean);
  const skipped = matches.length - rows.length;

  const valueCount = rows.filter(r => r.home_value || r.draw_value || r.away_value).length;
  console.log(`\n[engine] computed=${rows.length} skipped=${skipped} value=${valueCount}`);

  // P2-5: upsertComputedValues returns the current signals_written state for
  // every row in a single round-trip. The SELECT is part of the upsert call
  // (PostgREST RETURNING clause) — no extra query needed.
  let signalsWrittenMap;
  try {
    signalsWrittenMap = await upsertComputedValues(supabase, rows);
    console.log(`[engine] upserted ${rows.length} rows`);
  } catch (err) {
    console.error('[engine] fatal upsert:', err.message);
    process.exit(1);
  }

  // Skip signal insertion for matches whose signals were already committed
  // on a prior run (signals_written = true). This prevents re-emission when
  // the same match is processed again with identical computed data.
  const rowsNeedingSignals = rows.filter(r => !signalsWrittenMap.get(r.match_id));
  const alreadySignaled    = rows.length - rowsNeedingSignals.length;
  if (alreadySignaled > 0) {
    console.log(`[engine] signals_written checkpoint: ${alreadySignaled} match(es) already signaled, ${rowsNeedingSignals.length} pending`);
  }

  let recordedSignals = 0;
  if (rowsNeedingSignals.length > 0) {
    try {
      recordedSignals = await insertValueSignals(supabase, rowsNeedingSignals);

      // Commit checkpoint: mark value matches as signaled so they are skipped
      // on the next run. Non-value matches stay false so that if value emerges
      // later (odds shift) their signals can still be emitted.
      const valueMatchIds = rowsNeedingSignals
        .filter(r => r.home_value || r.draw_value || r.away_value)
        .map(r => r.match_id);

      if (valueMatchIds.length > 0) {
        const { error: cpErr } = await supabase
          .from('computed_values')
          .update({ signals_written: true })
          .in('match_id', valueMatchIds);

        if (cpErr) {
          // Non-fatal: signals were emitted. The 2h dedup in insertValueSignals
          // prevents duplicate emission on the next run if the checkpoint is missed.
          console.error(`[engine] signals_written checkpoint failed: ${cpErr.message}`);
        } else {
          console.log(`[engine] signals_written committed for ${valueMatchIds.length} match(es)`);
        }
      }
    } catch (err) {
      console.error('[engine] value_signals failed:', err.message);
    }
  }

  let botd = null;
  try {
    botd = await updateBetOfDay(supabase, rows);
  } catch (err) {
    console.error('[engine] BOTD failed:', err.message);
  }

  const summary = { processed: rows.length, skipped, valueSignals: valueCount, recordedSignals, botd };
  console.log('[engine] done', summary);
  return summary;
}

if (require.main === module) {
  run().catch(err => {
    console.error('[engine] unhandled:', err);
    process.exit(1);
  });
}

module.exports = {
  run, computeMatch, getSharpBaseline, getBestSoftOdds, getBestSoftTotalsBaseline: getSharpTotalsBaseline,
  deVig, computeEdge, computeEV,
  matchProbabilities, ratingFor, isRated, poisson, fetchMatchesForComputation, getClient,
  insertValueSignals, withPool,
  SOFT_BOOKS, SHARPNESS_MULTI_BOOK, SHARPNESS_SINGLE_BOOK, MULTI_BOOK_THRESHOLD, COMPUTE_CONCURRENCY,
};
