'use strict';

/**
 * lib/leagueSlug.js — production league (name, country) → training-corpus slug.
 *
 * THE SINGLE RESOLVER. This table used to live inside computeModelBoard.js,
 * where only the (gated) lambda board benefited from it. Everything else that
 * needed a corpus slug re-derived one by hand — and lib/halftimeFeatures.js in
 * particular matched on the NAME ALONE, so Russia's "Premier League" resolved
 * to `epl`, Austria's "Bundesliga" to `bundesliga` and Brazil's "Serie A" to
 * `seriea`. Those fixtures were priced with the wrong league one-hot on the
 * live pre-match path. Extracting the table here means there is one place that
 * answers "which corpus league is this?", and one place to fix when it's wrong.
 *
 * Pure (no I/O) so it is unit-tested.
 */

// Production league (name, country) → corpus league slug (the bundle's keys).
//
// COUNTRY IS PART OF THE KEY, not a hint parsed out of the name. Matching on the
// name alone silently mis-priced fixtures: API-Football calls both England's and
// Russia's top flight "Premier League", and both England's and Scotland's second
// tier "Championship", so Russian and Scottish games were being priced with
// ENGLISH league stats. Meanwhile Scotland's "Premiership" and Switzerland's
// "Super League" tested /scot/i and /switzerland/i against a name that never
// contained either word, so they resolved to null and were dropped entirely
// despite sc0 and switzerland_superleague existing in the bundle.
//
// Each entry is [nameRegex, resolver(country, name)]. First match with a
// non-null key wins, so put country-qualified names before generic ones.
const IN = (country, ...want) => want.some(w => new RegExp(w, 'i').test(country));

// Ambiguous names resolve by country, and fall back to the historically-assumed
// country when the row carries none — so a leagues row with a null country
// degrades to the old behaviour instead of dropping the fixture entirely.
const BY_COUNTRY = (map, fallback) => (c, _n, hasCountry) => {
  for (const [pattern, key] of map) if (IN(c, pattern)) return key;
  // A country we don't list is NOT the fallback — "Premier League" in Belarus is
  // not England's, and pricing it with EPL stats is the bug this whole change
  // exists to kill. Guess only when the row carries no country at all.
  return hasCountry ? null : fallback;
};

const LEAGUE_PATTERNS = [
  // ── Ambiguous names: the SAME string means different leagues by country ──
  // "Premier League" is England's and Russia's; "Championship"/"League One"/
  // "League Two" are England's and Scotland's. Matching on name alone priced
  // Russian and Scottish fixtures with ENGLISH league stats.
  [/premier league/i, BY_COUNTRY([['england', 'epl'], ['russia', 'russia_premierleague']], 'epl')],
  [/championship/i,   BY_COUNTRY([['scotland', 'sc1'], ['england', 'e1']], 'e1')],
  [/league one/i,     BY_COUNTRY([['scotland', 'sc2'], ['england', 'e2']], 'e2')],
  [/league two/i,     BY_COUNTRY([['scotland', 'sc3'], ['england', 'e3']], 'e3')],
  [/serie a/i,        BY_COUNTRY([['brazil', 'brazil_seriea'], ['italy', 'seriea']], 'seriea')],
  [/bundesliga 2|2\.? ?bundesliga/i, () => 'd2'],
  [/bundesliga/i,     BY_COUNTRY([['austria', 'austria_bundesliga'], ['germany', 'bundesliga']], 'bundesliga')],
  [/super league/i,   BY_COUNTRY([['greece', 'g1'], ['china', 'china_superleague'],
                                  ['switzerland', 'switzerland_superleague']], 'g1')],
  [/superliga|superligaen/i, BY_COUNTRY([['denmark', 'denmark_superliga'],
                                         ['romania', 'romania_superliga']], 'denmark_superliga')],

  // ── Unambiguous names: one league in the corpus, so country is not needed ──
  // Argentina's cup FIRST: "Copa de la Liga Profesional" contains the substring
  // "la Liga", so a later /la ?liga/ would otherwise price it as Spain's.
  [/copa de la liga/i, () => 'argentina_copadelaligaprofesional'],
  [/liga profesional/i, () => 'argentina_ligaprofesional'],
  [/national league/i, () => 'ec'],
  [/premiership/i, () => 'sc0'],
  [/challenge league/i, () => 'switzerland_challengeleague'],
  [/la ?liga|primera division/i, () => 'laliga'],
  [/segunda/i, () => 'sp2'],
  [/serie b/i, () => 'i2'],
  [/ligue 1/i, () => 'ligue1'],
  [/ligue 2/i, () => 'f2'],
  [/eredivisie/i, () => 'n1'],
  [/primeira liga|liga portugal/i, () => 'p1'],
  [/super lig/i, () => 't1'],
  [/pro league|jupiler/i, () => 'b1'],
  [/allsvenskan/i, () => 'allsvenskan'],
  [/eliteserien/i, () => 'norway_eliteserien'],
  [/veikkausliiga/i, () => 'finland_veikkausliiga'],
  [/ekstraklasa/i, () => 'poland_ekstraklasa'],
  // Romania's top flight is published as "Liga I"; the corpus slug carries its
  // sponsored name. Anchored so it cannot swallow "Liga II".
  [/^liga i$|^liga 1$/i, () => 'romania_superliga'],
  [/premier division/i, () => 'ireland_premierdivision'],
  [/mls|major league soccer/i, () => 'mls'],
  [/liga mx/i, () => 'mexico_ligamx'],
  [/j1|j-league/i, () => 'japan_j1league'],
];

/**
 * Strip diacritics before matching. API-Football publishes Turkey's top flight
 * as "Süper Lig", which /super lig/i does NOT match — so t1 never resolved and
 * every Turkish fixture was dropped, silently, for as long as this file has
 * existed. Folding here means a pattern can be written in plain ASCII and still
 * match "Süper Lig", "Segunda División", "Ligue 1 Uber Eats" and friends.
 */
function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function mapLeague(name, country) {
  const n = fold(name);
  // Fall back to the name when country is absent, so a row missing `country`
  // degrades to the old name-only behaviour rather than mapping nothing.
  const hasCountry = Boolean(fold(country));
  const c = fold(country) || n;
  for (const [re, fn] of LEAGUE_PATTERNS) {
    if (re.test(n)) {
      const key = fn(c, n, hasCountry);
      if (key) return key;
    }
  }
  return null;
}

module.exports = { mapLeague, fold, LEAGUE_PATTERNS };
