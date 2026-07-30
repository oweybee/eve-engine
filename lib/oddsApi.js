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
 * Corpus league key → matcher for The Odds API sport titles.
 * We resolve real sport KEYS from the free /v4/sports catalogue by matching on
 * group (country) + title, so a renamed key can't silently drop a league.
 */
const LEAGUE_MATCHERS = [
  // England
  ['epl', /^England$/i, /Premier League/i],
  ['e1', /^England$/i, /Championship/i],
  ['e2', /^England$/i, /League 1/i],
  ['e3', /^England$/i, /League 2/i],
  ['ec', /^England$/i, /National League/i],
  // Scotland
  ['sc0', /^Scotland$/i, /Premiership/i],
  // Big-5
  ['bundesliga', /^Germany$/i, /Bundesliga$|Bundesliga - /i],
  ['d2', /^Germany$/i, /Bundesliga 2/i],
  ['laliga', /^Spain$/i, /La Liga/i],
  ['sp2', /^Spain$/i, /Segunda/i],
  ['seriea', /^Italy$/i, /Serie A/i],
  ['i2', /^Italy$/i, /Serie B/i],
  ['ligue1', /^France$/i, /Ligue 1/i],
  ['f2', /^France$/i, /Ligue 2/i],
  // Rest of Europe
  ['n1', /^Netherlands$/i, /Eredivisie/i],
  ['p1', /^Portugal$/i, /Primeira/i],
  ['t1', /^Turkey$/i, /Super League|Süper/i],
  ['g1', /^Greece$/i, /Super League/i],
  ['b1', /^Belgium$/i, /First Div|Pro League/i],
  ['austria_bundesliga', /^Austria$/i, /Bundesliga/i],
  ['switzerland_superleague', /^Switzerland$/i, /Super League/i],
  ['denmark_superliga', /^Denmark$/i, /Superliga/i],
  ['norway_eliteserien', /^Norway$/i, /Eliteserien/i],
  ['allsvenskan', /^Sweden$/i, /Allsvenskan/i],
  ['finland_veikkausliiga', /^Finland$/i, /Veikkausliiga/i],
  ['poland_ekstraklasa', /^Poland$/i, /Ekstraklasa/i],
  ['romania_superliga', /^Romania$/i, /Liga I|Superliga/i],
  ['russia_premierleague', /^Russia$/i, /Premier League/i],
  ['ireland_premierdivision', /^Ireland$/i, /Premier Division/i],
  // Americas / Asia
  ['mls', /^USA$/i, /MLS|Major League Soccer/i],
  ['mexico_ligamx', /^Mexico$/i, /Liga MX/i],
  ['brazil_seriea', /^Brazil$/i, /Série A|Serie A|Campeonato/i],
  ['argentina_ligaprofesional', /^Argentina$/i, /Primera|Liga Profesional/i],
  ['japan_j1league', /^Japan$/i, /J League|J1/i],
  ['china_superleague', /^China$/i, /Super League/i],
];

/** Cups: priceable (clubs are known) but no league-specific calibration. */
const CUP_MATCHERS = [
  ['ucl', /^World$/i, /Champions League/i],
  ['uecl', /^World$/i, /Europa Conference/i],
  ['eng_league_cup', /^England$/i, /EFL Cup|League Cup|Carabao/i],
];

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

/** The FREE sports catalogue → { corpusKey: sportKey } for our tracked set. */
function mapSportKeys(sports, { includeCups = true } = {}) {
  const out = {};
  const unmatched = [];
  const matchers = includeCups ? [...LEAGUE_MATCHERS, ...CUP_MATCHERS] : LEAGUE_MATCHERS;
  for (const [key, groupRe, titleRe] of matchers) {
    const hit = (sports ?? []).find(s =>
      s.key?.startsWith('soccer') && groupRe.test(s.group ?? '') && titleRe.test(s.title ?? ''));
    if (hit) out[key] = hit.key;
    else unmatched.push(key);
  }
  return { map: out, unmatched };
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
  HOST, LEAGUE_MATCHERS, CUP_MATCHERS,
  httpGetJson, quotaFromHeaders, requestCost, canSpend, mapSportKeys, parseEvent,
};
