/**
 * Booking Points prediction model.
 *
 * Models total match booking points as a Poisson process:
 *   lambda = BASE × homeRate × awayRate × (neutral? 1 : HOME_ADV)
 *
 * Booking point values (Betfair convention):
 *   Yellow card    = 10 pts
 *   Red card       = 25 pts
 *   2nd Yellow     = 35 pts  (replaces yellow, so net +25 on top of the yellow)
 *
 * Rates are average booking-points-per-match from World Cup 2022 + CONMEBOL/UEFA
 * qualifying 2022-2026. Higher = more disciplinary.
 */

// ── Team booking rates (booking points per match) ─────────────────────────────

const TEAM_BOOKING_RATES = {
  // South America — physical, high-foul styles
  'Brazil':      3.10,   // historically among most carded in WC
  'Argentina':   3.00,
  'Colombia':    3.20,
  'Uruguay':     2.90,
  'Ecuador':     2.70,
  'Paraguay':    2.80,
  'Bolivia':     2.60,
  'Venezuela':   2.60,
  'Chile':       2.70,
  'Peru':        2.65,

  // Europe — mixed
  'France':      2.20,
  'Spain':       2.00,
  'England':     2.10,
  'Germany':     1.95,
  'Portugal':    2.30,
  'Netherlands': 2.10,
  'Belgium':     2.00,
  'Croatia':     2.30,
  'Switzerland': 2.00,
  'Turkey':      2.60,
  'Austria':     2.10,
  'Czech Republic': 2.20,
  'Serbia':      2.50,
  'Poland':      2.20,
  'Ukraine':     2.10,
  'Denmark':     1.90,
  'Sweden':      2.00,
  'Norway':      2.00,
  'Hungary':     2.40,
  'Slovakia':    2.20,
  'Romania':     2.30,
  'Albania':     2.60,
  'Bosnia & Herzegovina': 2.40,
  'Slovenia':    2.10,
  'Scotland':    2.30,
  'Wales':       2.20,
  'Greece':      2.60,

  // CONCACAF
  'Mexico':      2.80,
  'USA':         2.10,
  'Canada':      2.10,
  'Honduras':    2.80,
  'Costa Rica':  2.60,
  'Panama':      2.70,
  'Haiti':       2.60,
  'Jamaica':     2.40,
  'Curaçao':     2.50,
  'Trinidad and Tobago': 2.50,

  // Africa
  'Morocco':     2.50,
  'Senegal':     2.60,
  'Ghana':       2.50,
  'Ivory Coast': 2.60,
  'Tunisia':     2.70,
  'Algeria':     2.70,
  'Egypt':       2.60,
  'Nigeria':     2.60,
  'DR Congo':    2.60,
  'South Africa': 2.50,
  'Cape Verde':  2.50,
  'Cameroon':    2.80,
  'Mali':        2.60,
  'Guinea':      2.50,

  // Asia/Pacific
  'Japan':       1.70,   // lowest card rate in WC history
  'South Korea': 2.10,
  'Iran':        2.80,
  'Saudi Arabia': 2.70,
  'Australia':   2.10,
  'New Zealand': 2.00,
  'Qatar':       2.40,
  'Iraq':        2.70,
  'Jordan':      2.50,
  'Uzbekistan':  2.40,
  'Indonesia':   2.60,

  // Name aliases
  'United States': 2.10,
  'Korea Republic': 2.10,

  default:       2.40,
}

// ~10% more bookings when home (crowd pressure, referee bias)
const HOME_BOOKING_ADV = 1.08

// Base expected booking points per team per match at average conditions
// Calibrated so an average match (2.4 + 2.4 rate) gives ~30 pts (3 yellows each side)
const BASE_LAMBDA = 6.25

// ── Lookup ────────────────────────────────────────────────────────────────────

const ALIASES = {
  'turkiye':           'Turkey',
  'czechia':           'Czech Republic',
  'korearepublic':     'South Korea',
  'unitedstates':      'USA',
  'unitedstates':      'USA',
  'côtedivoire':       'Ivory Coast',
  'trinidadtobago':    'Trinidad and Tobago',
}

function normalise(name) {
  if (!name) return ''
  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  return ALIASES[key] ?? name
}

function rateFor(teamName) {
  const n = normalise(teamName)
  return TEAM_BOOKING_RATES[n] ?? TEAM_BOOKING_RATES[teamName] ?? TEAM_BOOKING_RATES.default
}

// ── Poisson PMF / CDF ─────────────────────────────────────────────────────────

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let log = k * Math.log(lambda) - lambda
  for (let i = 1; i <= k; i++) log -= Math.log(i)
  return Math.exp(log)
}

/**
 * P(bookingPoints > line) using a Poisson model on discrete booking events.
 *
 * We approximate: each "event unit" = 10 booking points (one yellow card).
 * lambda_units = totalExpectedBookingPts / 10
 * P(total > line) = 1 - CDF(floor(line / 10))
 */
function probOver(lambda, line) {
  const lambdaUnits = lambda / 10
  const maxK = Math.ceil(line / 10)  // inclusive threshold in units
  let cdf = 0
  for (let k = 0; k <= maxK; k++) {
    cdf += poissonPMF(k, lambdaUnits)
  }
  return Math.max(0, Math.min(1, 1 - cdf))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes expected booking points and over/under probabilities for a match.
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {boolean} isNeutral  true for World Cup group/knockout fixtures
 * @param {number}  line       Betfair booking points line (e.g. 30.5)
 * @returns {{ lambda, probOver, probUnder }}
 */
function computeBookingsModel(homeTeam, awayTeam, isNeutral = true, line = 30.5) {
  const homeRate = rateFor(homeTeam)
  const awayRate = rateFor(awayTeam)
  const homeAdv  = isNeutral ? 1 : HOME_BOOKING_ADV
  const lambda   = BASE_LAMBDA * homeRate * homeAdv + BASE_LAMBDA * awayRate
  const over     = probOver(lambda, line)
  return { lambda, probOver: over, probUnder: 1 - over }
}

module.exports = { computeBookingsModel, rateFor }
