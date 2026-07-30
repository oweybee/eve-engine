/**
 * lib/trackedLeagues.js — the leagues the engine ingests.
 *
 * Was three (World Cup, Allsvenskan, MLS), which meant the model-vs-market board
 * could only ever light up for two competitions. This is the full tracked set,
 * chosen from the intersection of:
 *   • what the model has HISTORY for (the 295k corpus → per-league calibration)
 *   • what API-Football covers
 *
 * `corpusKey` ties each league to its slug in the training corpus, so the board's
 * league_tag (proven / neutral / avoid, from out-of-sample ROI) resolves directly.
 * A null corpusKey means "priceable but uncalibrated" — cups where the CLUBS are
 * known from league play but the competition itself has no history.
 *
 * SELF-VERIFYING IDS: planDay compares each league's expected `name` against the
 * name API-Football returns for that id. A wrong or re-pointed id therefore shows
 * up as a loud warning in the run log rather than silently ingesting the wrong
 * competition. Every id is overridable by env (LEAGUE_ID_<KEY>) so a correction
 * needs no code change.
 */
'use strict';

// [apiId, displayName, country, corpusKey]
const LEAGUES = [
  // ── England (the model's strongest leagues) ──────────────────────────────
  [39,  'Premier League',        'England',       'epl'],
  [40,  'Championship',          'England',       'e1'],
  [41,  'League One',            'England',       'e2'],
  [42,  'League Two',            'England',       'e3'],
  [43,  'National League',       'England',       'ec'],
  [48,  'League Cup',            'England',       null],
  // ── Scotland ────────────────────────────────────────────────────────────
  [179, 'Premiership',           'Scotland',      'sc0'],
  [180, 'Championship',          'Scotland',      'sc1'],
  // ── Big-5 ───────────────────────────────────────────────────────────────
  [78,  'Bundesliga',            'Germany',       'bundesliga'],
  [79,  '2. Bundesliga',         'Germany',       'd2'],
  [140, 'La Liga',               'Spain',         'laliga'],
  [141, 'Segunda División',      'Spain',         'sp2'],
  [135, 'Serie A',               'Italy',         'seriea'],
  [136, 'Serie B',               'Italy',         'i2'],
  [61,  'Ligue 1',               'France',        'ligue1'],
  [62,  'Ligue 2',               'France',        'f2'],
  // ── Rest of Europe ──────────────────────────────────────────────────────
  [88,  'Eredivisie',            'Netherlands',   'n1'],
  [94,  'Primeira Liga',         'Portugal',      'p1'],
  [203, 'Süper Lig',             'Turkey',        't1'],
  [197, 'Super League',          'Greece',        'g1'],
  [144, 'Jupiler Pro League',    'Belgium',       'b1'],
  [218, 'Bundesliga',            'Austria',       'austria_bundesliga'],
  [207, 'Super League',          'Switzerland',   'switzerland_superleague'],
  [119, 'Superliga',             'Denmark',       'denmark_superliga'],
  [103, 'Eliteserien',           'Norway',        'norway_eliteserien'],
  [113, 'Allsvenskan',           'Sweden',        'allsvenskan'],
  [244, 'Veikkausliiga',         'Finland',       'finland_veikkausliiga'],
  [106, 'Ekstraklasa',           'Poland',        'poland_ekstraklasa'],
  [283, 'Liga I',                'Romania',       'romania_superliga'],
  [235, 'Premier League',        'Russia',        'russia_premierleague'],
  [357, 'Premier Division',      'Ireland',       'ireland_premierdivision'],
  // ── Americas / Asia ─────────────────────────────────────────────────────
  [253, 'Major League Soccer',   'USA',           'mls'],
  [262, 'Liga MX',               'Mexico',        'mexico_ligamx'],
  [71,  'Serie A',               'Brazil',        'brazil_seriea'],
  [128, 'Liga Profesional Argentina', 'Argentina', 'argentina_ligaprofesional'],
  [98,  'J1 League',             'Japan',         'japan_j1league'],
  [169, 'Super League',          'China',         'china_superleague'],
  // ── International (clubs known from league play; no competition history) ─
  [2,   'UEFA Champions League', 'World',         null],
  [3,   'UEFA Europa League',    'World',         null],
  [848, 'UEFA Europa Conference League', 'World', null],
  [1,   'FIFA World Cup',        'International', null],
];

/** Env override key for a league, e.g. LEAGUE_ID_EPL / LEAGUE_ID_UEFA_CHAMPIONS_LEAGUE. */
function envKeyFor(name, country) {
  return 'LEAGUE_ID_' + `${country}_${name}`
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The tracked list, with env-overridable ids. */
function trackedLeagues(env = process.env) {
  const only = (env.TRACKED_LEAGUE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const [id, name, country, corpusKey] of LEAGUES) {
    const override = parseInt(env[envKeyFor(name, country)] ?? '', 10);
    const league = { id: Number.isFinite(override) ? override : id, name, country, corpusKey };
    if (only.length && !only.includes(corpusKey ?? name)) continue;
    out.push(league);
  }
  return out;
}

/** Loose name check — the API's wording varies ("Serie A" vs "Serie A TIM"). */
function nameLooksRight(expected, actual) {
  if (!actual) return true;                      // nothing to compare against
  const norm = s => String(s).toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const e = norm(expected), a = norm(actual);
  return a.includes(e) || e.includes(a);
}

module.exports = { LEAGUES, trackedLeagues, nameLooksRight, envKeyFor };
