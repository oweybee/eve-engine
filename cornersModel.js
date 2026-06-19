/**
 * Total Corners prediction model.
 *
 * Models total match corners as a Poisson process:
 *   lambda = BASE × homeAttackStyle × awayAttackStyle × (neutral? 1 : HOME_ADV)
 *
 * Corner rates reflect attacking/wide-play style, not pure quality.
 * High press, wing-heavy teams generate more corners.
 * Calibrated from World Cup 2022 + major tournament data (avg ~10 corners/match).
 */

// ── Team corner rates (corners forced + won per match) ────────────────────────
// Scale: 1.0 = average (5 corners/match per team). Higher = more corner-generating style.

const TEAM_CORNER_RATES = {
  // High-pressing, wide-play systems
  'Spain':       1.35,
  'Germany':     1.30,
  'England':     1.25,
  'Netherlands': 1.25,
  'Portugal':    1.20,
  'France':      1.15,
  'Belgium':     1.15,
  'Brazil':      1.20,
  'Argentina':   1.10,
  'Croatia':     1.10,
  'Denmark':     1.20,
  'Norway':      1.15,
  'Sweden':      1.15,
  'Austria':     1.10,
  'Switzerland': 1.05,
  'Turkey':      1.05,
  'Poland':      1.05,
  'Ukraine':     1.05,
  'Czech Republic': 1.05,
  'Serbia':      1.05,
  'Hungary':     1.00,
  'Romania':     1.00,
  'Slovakia':    1.00,
  'Slovenia':    1.00,
  'Scotland':    1.05,
  'Wales':       1.00,
  'Albania':     0.95,
  'Greece':      0.95,
  'Bosnia & Herzegovina': 1.00,

  // CONCACAF
  'USA':         1.10,
  'Mexico':      1.05,
  'Canada':      1.05,
  'Costa Rica':  0.95,
  'Honduras':    0.95,
  'Panama':      0.90,
  'Jamaica':     0.90,
  'Haiti':       0.85,
  'Curaçao':     0.85,

  // South America
  'Colombia':    1.10,
  'Uruguay':     1.05,
  'Ecuador':     1.00,
  'Chile':       1.05,
  'Paraguay':    0.95,
  'Bolivia':     0.90,
  'Venezuela':   0.90,
  'Peru':        0.95,

  // Africa — physical, counter-attack styles tend to generate fewer corners
  'Morocco':     1.00,
  'Senegal':     0.95,
  'Ghana':       0.95,
  'Ivory Coast': 0.95,
  'Tunisia':     0.90,
  'Algeria':     0.90,
  'Egypt':       0.90,
  'Nigeria':     0.95,
  'DR Congo':    0.90,
  'South Africa': 0.90,
  'Cape Verde':  0.88,
  'Cameroon':    0.95,
  'Mali':        0.88,
  'Guinea':      0.88,

  // Asia/Pacific
  'Japan':       1.05,   // high-press style
  'South Korea': 1.00,
  'Australia':   1.00,
  'Iran':        0.90,
  'Saudi Arabia': 0.90,
  'Qatar':       0.85,
  'Iraq':        0.85,
  'Jordan':      0.85,
  'Uzbekistan':  0.88,
  'New Zealand': 0.88,
  'Indonesia':   0.85,

  // Aliases
  'United States':  1.10,
  'Korea Republic': 1.00,

  default: 0.95,
}

// Small home advantage for corners (crowd, territory)
const HOME_CORNER_ADV = 1.05

// Base such that two average teams (1.0 × 1.0) produce ~10 corners total
// lambda per team ≈ 5, so BASE = 5
const BASE_LAMBDA = 5.0

// ── Lookup ─────────────────────────────────────────────────────────────────────

const ALIASES = {
  'turkiye':        'Turkey',
  'czechia':        'Czech Republic',
  'korearepublic':  'South Korea',
  'unitedstates':   'USA',
  'côtedivoire':    'Ivory Coast',
}

function normalise(name) {
  if (!name) return ''
  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  return ALIASES[key] ?? name
}

function rateFor(teamName) {
  const n = normalise(teamName)
  return TEAM_CORNER_RATES[n] ?? TEAM_CORNER_RATES[teamName] ?? TEAM_CORNER_RATES.default
}

// ── Poisson PMF ────────────────────────────────────────────────────────────────

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let log = k * Math.log(lambda) - lambda
  for (let i = 1; i <= k; i++) log -= Math.log(i)
  return Math.exp(log)
}

function probOver(lambda, line) {
  const maxK = Math.floor(line)
  let cdf = 0
  for (let k = 0; k <= maxK; k++) cdf += poissonPMF(k, lambda)
  return Math.max(0, Math.min(1, 1 - cdf))
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * @param {string}  homeTeam
 * @param {string}  awayTeam
 * @param {boolean} isNeutral
 * @param {number}  line       e.g. 9.5
 * @returns {{ lambda, probOver, probUnder }}
 */
function computeCornersModel(homeTeam, awayTeam, isNeutral = true, line = 9.5) {
  const homeRate = rateFor(homeTeam)
  const awayRate = rateFor(awayTeam)
  const homeAdv  = isNeutral ? 1 : HOME_CORNER_ADV
  const lambda   = BASE_LAMBDA * homeRate * homeAdv + BASE_LAMBDA * awayRate
  const over     = probOver(lambda, line)
  return { lambda, probOver: over, probUnder: 1 - over }
}

module.exports = { computeCornersModel, rateFor }
