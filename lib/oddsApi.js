/**
 * lib/oddsApi.js — The Odds API (the-odds-api.com) v4 client + pure helpers.
 *
 * ROLE IN THE STACK
 * ─────────────────
 * API-Football owns the match spine (fixtures, live state, stats) and provides
 * the high-frequency polling that drives the movement chart. The Odds API's ONLY
 * job here is BREADTH — the UK soft books (Sky Bet, Paddy Power, Coral,
 * Ladbrokes, Betfred, BoyleSports…) that API-Football doesn't carry, and which
 * are where the measured +6.99% best-price advantage actually comes from.
 *
 * Because it's breadth and not frequency, we poll it sparsely. That is what
 * keeps the whole thing inside the 100k-credit ($59) tier.
 *
 * BILLING MODEL (why the code is shaped this way)
 * ──────────────────────────────────────────────
 *   • One request per SPORT (league) returns every upcoming event in it, with
 *     every bookmaker — so cost scales with LEAGUES × POLLS, not fixtures.
 *   • Cost per request ≈ regions × markets. `regions=uk&markets=h2h,totals` = 2.
 *   • /v4/sports (the league catalogue) is FREE — so we discover sport keys at
 *     runtime instead of hardcoding a list that silently rots.
 *   • Every response carries x-requests-used / x-requests-remaining. That is the
 *     AUTHORITATIVE quota counter — we trust it over our own estimate and stop
 *     when the reserve is reached.
 *
 * Pure functions (parsing, mapping, guard arithmetic) are exported for tests;
 * the HTTP surface is a thin wrapper.
 */
'use strict';

const https = require('https');

const HOST = 'api.the-odds-api.com';

/**
 * Corpus league key → The Odds API sport key.
 *
 * THIS WAS A GROUP+TITLE REGEX MATCHER AND IT RESOLVED ZERO LEAGUES FOR AS
 * LONG AS IT EXISTED. Every entry tested `group` against a COUNTRY
 * (/^England$/i). Measured against the live catalogue on 22 Aug 2026:
 * `group` is the literal string "Soccer" on ALL 67 soccer entries and on
 * nothing else — the country, where it appears at all, is a suffix of the
 * TITLE ("Ligue 1 - France"). So no matcher could ever fire, `ingestOddsApi`
 * polled nothing, and the account had spent 0 of its 100,000 monthly credits
 * since the integration was written.
 *
 * The 46 tests over this module passed throughout. They ran against fixtures
 * carrying `group: 'England'`, authored from the v4 docs by the same hand that
 * wrote the matchers — a fixture built from a guess tests the guess, and this
 * module's own header said so ("NONE OF IT HAS MET THE REAL FEED").
 *
 * SO THE KEY IS THE IDENTITY NOW, and the title is only a fallback. `key` is
 * the one field The Odds API documents as stable; a title is display copy.
 *
 * EVERY KEY BELOW WAS COPIED FROM THE LIVE CATALOGUE, not from the docs and
 * not from memory — `scripts/oddsApiCatalogue.js` prints it from a runner for
 * free (/v4/sports costs no credits). Re-run it before editing this table.
 *
 * TWO COMPETITIONS HAVE NO KEY AND THAT IS A FACT ABOUT THE FEED, NOT A GAP
 * HERE. The catalogue offers no England National League and no Romanian
 * division at all. They carry `sportKey: null` and are reported as
 * `unavailable` rather than `unmatched`, because "the API does not sell this"
 * and "we cannot find what we are looking for" are different problems and only
 * the second one is ours. Never invent a key to make a table look complete: an
 * unlisted key is a 404 per request, and a WRONG key silently polls another
 * competition.
 *
 * THE ENGLISH PYRAMID IS THE TRAP. Our corpus keys are football-data.co.uk
 * codes, where e1 is the CHAMPIONSHIP, e2 is League One and e3 is League Two —
 * each one division below what its digit suggests. Mapping e1→league1 shifts
 * the whole pyramid by one, polls the Championship twice and never polls
 * League Two. `sportKeysAreUnique` is the ratchet under that.
 */
const SPORT_KEYS = [
  // ── England ───────────────────────────────────────────────────────────────
  // e1 is the CHAMPIONSHIP. Read the note above before touching these four.
  { corpusKey: 'epl',    sportKey: 'soccer_epl',                  title: /^EPL$|English Premier League/i },
  { corpusKey: 'e1',     sportKey: 'soccer_efl_champ',            title: /^Championship$|EFL Championship/i },
  { corpusKey: 'e2',     sportKey: 'soccer_england_league1',      title: /^League 1$|EFL League 1/i },
  { corpusKey: 'e3',     sportKey: 'soccer_england_league2',      title: /^League 2$|EFL League 2/i },
  // Not in the catalogue, 22 Aug 2026. Kept so the gap is NAMED on every run.
  { corpusKey: 'ec',     sportKey: null,                          title: /National League/i },
  // ── Scotland ──────────────────────────────────────────────────────────────
  { corpusKey: 'sc0',    sportKey: 'soccer_spl',                  title: /Premiership - Scotland|Scottish Premiership/i },
  // ── Big five ──────────────────────────────────────────────────────────────
  { corpusKey: 'bundesliga', sportKey: 'soccer_germany_bundesliga',  title: /^Bundesliga - Germany$/i },
  { corpusKey: 'd2',     sportKey: 'soccer_germany_bundesliga2',  title: /^Bundesliga 2 - Germany$/i },
  { corpusKey: 'laliga', sportKey: 'soccer_spain_la_liga',        title: /^La Liga - Spain$/i },
  { corpusKey: 'sp2',    sportKey: 'soccer_spain_segunda_division', title: /^La Liga 2 - Spain$|Segunda Divisi/i },
  { corpusKey: 'seriea', sportKey: 'soccer_italy_serie_a',        title: /^Serie A - Italy$/i },
  { corpusKey: 'i2',     sportKey: 'soccer_italy_serie_b',        title: /^Serie B - Italy$/i },
  { corpusKey: 'ligue1', sportKey: 'soccer_france_ligue_one',     title: /^Ligue 1 - France$/i },
  { corpusKey: 'f2',     sportKey: 'soccer_france_ligue_two',     title: /^Ligue 2 - France$/i },
  // ── Rest of Europe ────────────────────────────────────────────────────────
  { corpusKey: 'n1',     sportKey: 'soccer_netherlands_eredivisie', title: /Eredivisie/i },
  { corpusKey: 'p1',     sportKey: 'soccer_portugal_primeira_liga', title: /Primeira Liga - Portugal/i },
  { corpusKey: 't1',     sportKey: 'soccer_turkey_super_league',  title: /Turkey Super League/i },
  { corpusKey: 'g1',     sportKey: 'soccer_greece_super_league',  title: /Super League - Greece/i },
  { corpusKey: 'b1',     sportKey: 'soccer_belgium_first_div',    title: /Belgium First Div/i },
  { corpusKey: 'austria_bundesliga',      sportKey: 'soccer_austria_bundesliga',      title: /Austrian Football Bundesliga/i },
  { corpusKey: 'switzerland_superleague', sportKey: 'soccer_switzerland_superleague', title: /Swiss Superleague/i },
  { corpusKey: 'denmark_superliga',       sportKey: 'soccer_denmark_superliga',       title: /Denmark Superliga/i },
  { corpusKey: 'norway_eliteserien',      sportKey: 'soccer_norway_eliteserien',      title: /Eliteserien - Norway/i },
  { corpusKey: 'allsvenskan',             sportKey: 'soccer_sweden_allsvenskan',      title: /Allsvenskan - Sweden/i },
  { corpusKey: 'finland_veikkausliiga',   sportKey: 'soccer_finland_veikkausliiga',   title: /Veikkausliiga - Finland/i },
  { corpusKey: 'poland_ekstraklasa',      sportKey: 'soccer_poland_ekstraklasa',      title: /Ekstraklasa - Poland/i },
  // Not in the catalogue, 22 Aug 2026 — no Romanian division is offered.
  { corpusKey: 'romania_superliga',       sportKey: null,                             title: /Liga I - Romania|Superliga - Romania/i },
  { corpusKey: 'russia_premierleague',    sportKey: 'soccer_russia_premier_league',   title: /Premier League - Russia/i },
  { corpusKey: 'ireland_premierdivision', sportKey: 'soccer_league_of_ireland',       title: /League of Ireland/i },
  // ── Americas and Asia ─────────────────────────────────────────────────────
  { corpusKey: 'mls',                     sportKey: 'soccer_usa_mls',                 title: /^MLS$|Major League Soccer/i },
  { corpusKey: 'mexico_ligamx',           sportKey: 'soccer_mexico_ligamx',           title: /Liga MX/i },
  // Anchored on A: the catalogue carries soccer_brazil_serie_b beside it.
  { corpusKey: 'brazil_seriea',           sportKey: 'soccer_brazil_campeonato',       title: /Brazil S[ée]rie A(?!\w)|Brasileir/i },
  { corpusKey: 'argentina_ligaprofesional', sportKey: 'soccer_argentina_primera_division', title: /Primera Divisi[óo]n - Argentina/i },
  { corpusKey: 'japan_j1league',          sportKey: 'soccer_japan_j_league',          title: /^J League$/i },
  { corpusKey: 'china_superleague',       sportKey: 'soccer_china_superleague',       title: /Super League - China/i },
  // ── Cups: priceable (the clubs are known) but no league calibration ───────
  // Anchored: the catalogue also carries _qualification and _women variants.
  { corpusKey: 'ucl',            sportKey: 'soccer_uefa_champs_league',            title: /^UEFA Champions League$/i, cup: true },
  { corpusKey: 'uecl',           sportKey: 'soccer_uefa_europa_conference_league', title: /^UEFA Europa Conference League$/i, cup: true },
  { corpusKey: 'eng_league_cup', sportKey: 'soccer_england_efl_cup',               title: /^EFL Cup$|^League Cup$/i, cup: true },
];

/**
 * No two corpus keys may claim one sport key. This is the shifted-pyramid bug's
 * signature: map e1→league1 and e2→league2 and the Championship is polled under
 * two names while League Two is never polled at all — a coverage hole that
 * spends MORE credits than the correct table, and looks entirely healthy in the
 * run log. Exported so the test can assert it rather than trusting the diff.
 */
function sportKeysAreUnique() {
  const seen = new Map();
  const clashes = [];
  for (const e of SPORT_KEYS) {
    if (!e.sportKey) continue;
    if (seen.has(e.sportKey)) clashes.push(`${seen.get(e.sportKey)} and ${e.corpusKey} both claim ${e.sportKey}`);
    else seen.set(e.sportKey, e.corpusKey);
  }
  return clashes;
}

/**
 * The FREE sports catalogue → { corpusKey: sportKey } for our tracked set.
 *
 * The CATALOGUE is the authority and the table above is only our intent: a key
 * is used because the live response carries it, never because it is typed here.
 * A hand-copy that nothing checks is what `MODEL_SIGMA` cost this project twice
 * in production without either copy throwing.
 *
 * @param sports  the /v4/sports payload
 * @param opts    { includeCups = true, targetLeagues = null } — or an ARRAY of
 *                corpus keys, which is read as targetLeagues.
 * @returns {{map, unmatched, unavailable, renamed, collisions}}
 *   map         corpusKey → sportKey, confirmed present in the catalogue
 *   unmatched   we expected a key and the catalogue does not carry it — OURS
 *   unavailable the feed does not offer this competition at all — not ours
 *   renamed     found by title after the expected key was absent; a rename
 *   collisions  two corpus keys resolved to one sport key
 */
function mapSportKeys(sports, opts = {}) {
  const { includeCups = true, targetLeagues = null } =
    Array.isArray(opts) ? { targetLeagues: opts } : (opts ?? {});

  // Soccer only. A non-soccer key must never enter the map even by title —
  // "Super League" is also a rugby competition in this catalogue's neighbours.
  const available = new Map();
  for (const s of sports ?? []) {
    const key = String(s?.key ?? '');
    if (key.startsWith('soccer')) available.set(key, s);
  }

  const map = {};
  const unmatched = [];
  const unavailable = [];
  const renamed = [];

  for (const entry of SPORT_KEYS) {
    if (!includeCups && entry.cup) continue;
    if (targetLeagues && !targetLeagues.includes(entry.corpusKey)) continue;

    // 1. The key, confirmed against the live catalogue.
    if (entry.sportKey && available.has(entry.sportKey)) {
      map[entry.corpusKey] = entry.sportKey;
      continue;
    }

    // 2. Fallback: title or description, and ONLY on a unique hit. Several of
    //    these titles are near-duplicates across countries ("Super League"
    //    appears for Greece, China, Turkey and Switzerland), so an ambiguous
    //    match is refused rather than resolved to whichever came first —
    //    the same rule `matchEventToFixture` applies to team names, and for
    //    the same reason: a wrong league is worse than a missing one.
    const hits = [];
    for (const s of available.values()) {
      if (!entry.title) break;
      if (entry.title.test(s.title ?? '') || entry.title.test(s.description ?? '')) hits.push(s.key);
    }
    if (hits.length === 1) {
      map[entry.corpusKey] = hits[0];
      renamed.push(`${entry.corpusKey}: expected ${entry.sportKey ?? '(none)'} — resolved ${hits[0]} by title`);
      continue;
    }

    // 3. Nothing. Say WHICH kind of nothing.
    if (entry.sportKey == null) unavailable.push(entry.corpusKey);
    else unmatched.push(entry.corpusKey);
  }

  const seen = new Map();
  const collisions = [];
  for (const [ck, sk] of Object.entries(map)) {
    if (seen.has(sk)) collisions.push(`${seen.get(sk)} and ${ck} both resolved to ${sk}`);
    else seen.set(sk, ck);
  }

  return { map, unmatched, unavailable, renamed, collisions };
}

function httpGetJson(path) {
  return new Promise((resolve, reject) => {
    https.get({ host: HOST, path, headers: { 'User-Agent': 'eve-engine/1.0' } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('ODDS_API_KEY rejected (401)'));
        if (res.statusCode === 429) return reject(new Error('Odds API quota exhausted (429)'));
        if (res.statusCode >= 400) return reject(new Error(`Odds API ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          resolve({ json: JSON.parse(body), headers: res.headers });
        } catch (e) { reject(new Error(`Odds API bad JSON: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/** Quota state from response headers (authoritative — beats our own estimate). */
function quotaFromHeaders(headers = {}) {
  const used = parseInt(headers['x-requests-used'] ?? '', 10);
  const remaining = parseInt(headers['x-requests-remaining'] ?? '', 10);
  const last = parseInt(headers['x-requests-last'] ?? '', 10);
  return {
    used: Number.isFinite(used) ? used : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    lastCost: Number.isFinite(last) ? last : null,
  };
}

/** Credits one odds request costs: regions × markets. */
function requestCost(regions, markets) {
  const r = String(regions).split(',').filter(Boolean).length;
  const m = String(markets).split(',').filter(Boolean).length;
  return Math.max(1, r * m);
}

/**
 * Should we make another request?
 * Hard guard: never spend below `reserve` remaining credits, so a runaway loop
 * can't drain the month's allowance.
 */
function canSpend({ remaining, cost, reserve }) {
  if (remaining == null) return true;            // unknown yet — first call establishes it
  return remaining - cost >= reserve;
}
/**
 * Parse one Odds API event into our `odds` row shape (one row per bookmaker).
 * Totals follow the engine convention: market='totals', home_odds=over,
 * away_odds=under, market_line=the line.
 */
function parseEvent(event, { totalsLine = 2.5 } = {}) {
  const rows = [];
  const now = new Date().toISOString();
  for (const bm of event.bookmakers ?? []) {
    const book = String(bm.key ?? '').toLowerCase();
    if (!book) continue;
    for (const mk of bm.markets ?? []) {
      if (mk.key === 'h2h') {
        let home = null, draw = null, away = null;
        for (const o of mk.outcomes ?? []) {
          if (o.name === event.home_team) home = Number(o.price);
          else if (o.name === event.away_team) away = Number(o.price);
          else if (/^draw$/i.test(o.name ?? '')) draw = Number(o.price);
        }
        if (home > 1 && away > 1) {
          rows.push({ bookmaker: book, market: 'h2h', market_line: null,
                      home_odds: home, draw_odds: draw > 1 ? draw : null,
                      away_odds: away, fetched_at: now });
        }
      } else if (mk.key === 'totals') {
        let over = null, under = null;
        for (const o of mk.outcomes ?? []) {
          if (Number(o.point) !== totalsLine) continue;
          if (/^over$/i.test(o.name ?? '')) over = Number(o.price);
          else if (/^under$/i.test(o.name ?? '')) under = Number(o.price);
        }
        if (over > 1 && under > 1) {
          rows.push({ bookmaker: book, market: 'totals', market_line: totalsLine,
                      home_odds: over, draw_odds: null, away_odds: under,
                      fetched_at: now });
        }
      }
    }
  }
  return rows;
}

module.exports = {
  HOST, SPORT_KEYS, sportKeysAreUnique,
  httpGetJson, quotaFromHeaders, requestCost, canSpend, mapSportKeys, parseEvent,
};
