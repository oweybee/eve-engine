'use strict';
/**
 * lib/selectionLabel.js — the ONE place the engine turns a stored selection
 * (market, outcome, market_line) into words a reader sees.
 *
 * It mirrors public.selection_label(market, outcome, line, home, away) in the
 * database, statement for statement, so a Discord post, a Telegram message, an
 * X post and the site all name one bet the same way. Read the SQL with
 *   select pg_get_functiondef('public.selection_label'::regproc)
 * and change both together. engine.selectionlabel.test.js pins the outputs.
 *
 * Vocabulary (value_signals):
 *   h2h       home | draw | away
 *   totals    over | under at a goals line
 *   btts      btts_yes | btts_no
 *   dc        dc_1x | dc_12 | dc_x2                 (line null)
 *   dnb       dnb_home | dnb_away                   (line null)
 *   ah        ah_home | ah_away; market_line is the HOME handicap, so the away
 *             side reads home's line negated
 *   corners   over | under at a corners line
 *   bookings  over | under at a cards line; 'cards' is the older key and is
 *             treated identically
 *
 * Deliberate departures from the SQL, each a place the SQL returns NULL
 * or an unhelpful string rather than a label, and none changing any output the
 * SQL gives for a well-formed row:
 *   1. A null market, or an 'h2h' market carrying a non-1X2 outcome, is
 *      INFERRED from the outcome (over -> totals, btts_* -> btts, dc_* -> dc,
 *      ...) where the SQL defaults to h2h and would print 'Draw' for an Over.
 *   2. 'cards' is read as 'bookings' (the SQL has no 'cards' branch).
 *   3. An unknown market or outcome fails OPEN to the raw outcome with
 *      underscores as spaces (Telegram Markdown reads '_' as italics), and a
 *      missing line is dropped rather than nulling the whole label.
 */

const MARKET_NAMES = {
  h2h: 'Match result',
  totals: 'Goals',
  btts: 'Both teams to score',
  dc: 'Double chance',
  dnb: 'Draw no bet',
  ah: 'Asian handicap',
  corners: 'Corners',
  bookings: 'Cards',
};

/** Canonical market key: lower-cased, 'cards' folded into 'bookings'. */
function normaliseMarket(market, outcome) {
  const m = market == null || market === '' ? null : String(market).toLowerCase();
  if (m === 'cards') return 'bookings';
  const o = String(outcome ?? '').toLowerCase();
  // An h2h row whose outcome is not home/draw/away is mislabelled, not a draw:
  // read the market off the outcome rather than printing 'Draw' for an Over.
  if (m && !(m === 'h2h' && !['home', 'draw', 'away'].includes(o))) return m;
  if (o === 'over' || o === 'under') return 'totals';
  if (o.startsWith('btts_')) return 'btts';
  if (o.startsWith('dc_')) return 'dc';
  if (o.startsWith('dnb_')) return 'dnb';
  if (o.startsWith('ah_')) return 'ah';
  return 'h2h';
}

/** Reader-facing market name, e.g. 'Double chance'. Unknown keys fail open. */
function marketName(market) {
  if (market == null || market === '') return MARKET_NAMES.h2h;
  const m = normaliseMarket(market);
  return MARKET_NAMES[m] ?? String(market);
}

/** trim_scale(numeric)::text — 2.50 -> '2.5', -0 -> '0'. Null if not a number. */
function lineText(line) {
  if (line == null || line === '') return null;
  const n = Number(line);
  if (!Number.isFinite(n)) return null;
  return String(n === 0 ? 0 : n);
}

/** initcap of a single word: 'over' -> 'Over'. */
function initcap(s) {
  const t = String(s ?? '').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function fallback(outcome) {
  return String(outcome ?? '').replace(/_/g, ' ');
}

function overUnder(outcome, line, noun) {
  const o = String(outcome ?? '').toLowerCase();
  if (o !== 'over' && o !== 'under') return fallback(outcome);
  const l = lineText(line);
  return `${initcap(o)}${l != null ? ` ${l}` : ''} ${noun}`;
}

/** Signed handicap text: '+1', '-0.5', '0'. */
function signed(n) {
  const t = lineText(n);
  if (t == null) return null;
  return Number(n) > 0 ? `+${t}` : t;
}

/**
 * The label for one selection.
 * @param {{market?:string|null, outcome:string, line?:number|string|null,
 *          home?:string|null, away?:string|null}} sel
 */
function selectionLabel({ market, outcome, line = null, home, away } = {}) {
  const h = home ?? 'Home';
  const a = away ?? 'Away';
  const o = String(outcome ?? '').toLowerCase();
  switch (normaliseMarket(market, outcome)) {
    case 'h2h':
      if (o === 'home') return `${h} to win`;
      if (o === 'away') return `${a} to win`;
      if (o === 'draw') return 'Draw';
      return fallback(outcome);
    case 'totals':   return overUnder(outcome, line, 'goals');
    case 'corners':  return overUnder(outcome, line, 'corners');
    case 'bookings': return overUnder(outcome, line, 'cards');
    case 'btts':
      if (o === 'btts_yes') return 'Both teams to score: Yes';
      if (o === 'btts_no') return 'Both teams to score: No';
      return fallback(outcome);
    case 'dc':
      if (o === 'dc_1x') return `${h} or draw`;
      if (o === 'dc_x2') return `${a} or draw`;
      if (o === 'dc_12') return `${h} or ${a}`;
      return fallback(outcome);
    case 'dnb':
      if (o === 'dnb_home') return `${h} (draw no bet)`;
      if (o === 'dnb_away') return `${a} (draw no bet)`;
      return fallback(outcome);
    case 'ah': {
      if (o !== 'ah_home' && o !== 'ah_away') return fallback(outcome);
      const n = lineText(line) == null ? null : Number(line);
      const side = o === 'ah_home' ? h : a;
      const hcp = n == null ? null : signed(o === 'ah_home' ? n : -n);
      return `${side}${hcp != null ? ` ${hcp}` : ''} (Asian handicap)`;
    }
    default:
      return fallback(outcome);
  }
}

/** Convenience over a value_signals row with an embedded match. */
function selectionLabelForSignal(signal) {
  return selectionLabel({
    market: signal?.market,
    outcome: signal?.outcome,
    line: signal?.market_line,
    home: signal?.match?.home_team?.name,
    away: signal?.match?.away_team?.name,
  });
}

module.exports = { selectionLabel, selectionLabelForSignal, marketName, normaliseMarket, MARKET_NAMES };
