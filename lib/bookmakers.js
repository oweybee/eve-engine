/**
 * lib/bookmakers.js — ONE bookmaker identity, and it is the KEY.
 *
 * WHY THIS EXISTS. The same book was stored two ways in one column, in five
 * tables, including member-owned ones. Measured against production 22 Aug 2026:
 *
 *   odds                     31 distinct, all keys        (correct)
 *   value_signals            29 distinct, BOTH forms      bet365 AND Bet365,
 *                                                         sbo AND SBO,
 *                                                         unibet_uk AND Unibet,
 *                                                         williamhill AND
 *                                                         'William Hill' ...
 *   computed_values          10 distinct, BOTH forms      10bet, dafabet as keys
 *                                                         beside Bet365, SBO
 *   bets            (member) 7 distinct, BOTH forms       bet365 AND Bet365
 *   user_bookmakers (member) 2 distinct, display only     Bet365, Paddy Power
 *
 * Any `group by bookmaker` double-counts. Any join or `.eq()` on it silently
 * matches half the rows. It broke two of this session's own measurements
 * inside ten minutes — first inflating "positive edges at a new book" to 52
 * when the true figure was 0, then mislabelling seven signal rows as newly
 * arrived books when they were the same books under display casing.
 *
 * THE CAUSE WAS A PRESENTATION FUNCTION AT THE WRITE LAYER. `formatBookName`
 * turned a key into a display string, and computeValues called it while
 * BUILDING THE ROW — so a label was persisted where an identifier belonged.
 * It existed twice, in computeValues.js and computeApiValues.js, with
 * different contents: the second was missing marathonbet, betano, 1xbet, sbo
 * and 10bet, so the same book got different spellings depending on which
 * writer ran. That is the hand-copy failure this repo has paid for repeatedly.
 *
 * THE RULE: the database stores KEYS. A label is produced at the point of
 * display and nowhere else. `bookmakerKey` is idempotent, so it is safe to
 * call on a value that is already canonical — which is what makes it usable
 * on read as well as write while both forms are still in the tables.
 */
'use strict';

/** key → the name a reader should see. The ONLY place a label is declared. */
const BOOKMAKER_LABEL = Object.freeze({
  bet365: 'Bet365',
  betfair_sb_uk: 'Betfair SB',
  betfair_ex_uk: 'Betfair Exch',
  williamhill: 'William Hill',
  paddypower: 'Paddy Power',
  skybet: 'Sky Bet',
  coral: 'Coral',
  ladbrokes_uk: 'Ladbrokes',
  betfred_uk: 'Betfred',
  boylesports: 'BoyleSports',
  betway: 'Betway',
  betvictor: 'BetVictor',
  unibet_uk: 'Unibet',
  virginbet: 'Virgin Bet',
  '888sport': '888sport',
  sport888: '888sport (UK)',
  leovegas: 'LeoVegas',
  casumo: 'Casumo',
  grosvenor: 'Grosvenor',
  livescorebet: 'LiveScore Bet',
  smarkets: 'Smarkets',
  matchbook: 'Matchbook',
  pinnacle: 'Pinnacle',
  betsson: 'Betsson',
  betano: 'Betano',
  // SAME OPERATOR, TWO VENDOR KEYS — see the note below. Labelled apart so a
  // reader is never shown one name twice on one price panel.
  betano_uk: 'Betano (UK)',
  marathonbet: 'MarathonBet',
  superbet: 'Superbet',
  dafabet: 'Dafabet',
  '1xbet': '1xBet',
  sbo: 'SBO',
  '10bet': '10bet',
  coolbet: 'Coolbet',
});

/**
 * Legacy and upstream spellings → canonical key.
 *
 * Everything a writer has EVER put in one of these columns, plus the feed
 * names API-Football supplies. Derived from the two maps this replaces and
 * from the distinct values measured in production, so no historical row is
 * left unresolvable.
 */
const ALIASES = Object.freeze({
  // Display forms found in value_signals / computed_values / bets / user_bookmakers
  'bet365': 'bet365',
  'betfair sb': 'betfair_sb_uk',
  'betfair exch': 'betfair_ex_uk',
  'betfair exchange': 'betfair_ex_uk',
  'betfair': 'betfair_sb_uk',
  'william hill': 'williamhill',
  'paddy power': 'paddypower',
  'sky bet': 'skybet',
  'skybet': 'skybet',
  'ladbrokes': 'ladbrokes_uk',
  'betfred': 'betfred_uk',
  'boylesports': 'boylesports',
  'virgin bet': 'virginbet',
  'unibet': 'unibet_uk',
  'leovegas': 'leovegas',
  'livescore bet': 'livescorebet',
  'marathonbet': 'marathonbet',
  '1xbet': '1xbet',
  'sbo': 'sbo',
  '10bet': '10bet',
  coolbet: 'Coolbet',
  'betano': 'betano',
  'betano (uk)': 'betano_uk',
  '888sport (uk)': 'sport888',
  'betvictor': 'betvictor',
  'pinnacle': 'pinnacle',
  'superbet': 'superbet',
  'dafabet': 'dafabet',
});

/**
 * Any spelling → the canonical key. IDEMPOTENT: bookmakerKey(bookmakerKey(x))
 * === bookmakerKey(x), which is what lets it sit on the read path while both
 * forms are still in the tables.
 *
 * FAILS OPEN, deliberately. An unknown book returns a slug of its own name
 * rather than null: dropping it would leave a member's stored bet with no
 * bookmaker at all, and a book we have not met yet is not an error.
 */
function bookmakerKey(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BOOKMAKER_LABEL, lower)) return lower;
  if (Object.prototype.hasOwnProperty.call(ALIASES, lower)) return ALIASES[lower];
  // Unknown: slugify the way the existing keys are shaped.
  return lower.replace(/[^a-z0-9]+/g, '');
}

/** Canonical key → the name a reader should see. Falls open to the key. */
function bookmakerLabel(input) {
  const key = bookmakerKey(input);
  if (key == null) return null;
  return BOOKMAKER_LABEL[key] ?? key;
}

/**
 * TWO VENDORS SUPPLY THE SAME OPERATOR UNDER DIFFERENT KEYS, and the keys are
 * kept APART here on purpose. `odds` carries both `betano` and `betano_uk`,
 * and both `888sport` and `sport888` — the first of each from API-Football,
 * the second from The Odds API. They are almost certainly one book.
 *
 * Merging them is a PRICING decision, not a labelling one: best-price counts
 * distinct bookmakers, so collapsing a pair changes book depth on every panel
 * and changes which quote wins. That needs its own measurement — how often
 * both appear on one fixture, and whether their prices agree — and it is not
 * something to decide inside a rename. Until then they stay separate rows with
 * separate labels, so the UI never shows one name twice and nobody reads a
 * duplicate as two independent books.
 */
module.exports = { BOOKMAKER_LABEL, ALIASES, bookmakerKey, bookmakerLabel };
