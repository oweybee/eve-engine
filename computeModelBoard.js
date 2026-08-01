/**
 * computeModelBoard.js — the "model vs market" board stage.
 *
 * For every scheduled fixture with fresh odds, runs the λ goals-model
 * (lib/lambdaBoard.js → ONNX + Dixon-Coles price sheet) against the live
 * market and records genuine disagreements to value_signals with
 * model_architecture='LAMBDA_MC', including the board display fields
 * (model_prob, market_prob, credible_score, league_tag, price_seg).
 *
 * Honesty rules baked in (from the out-of-sample evaluation):
 *   • edge threshold (LAMBDA_EV_THRESHOLD, default 3%)
 *   • edges above the bundle's max_plausible_edge dropped (stale prices)
 *   • ranked by credible score (favourite/mid up-weighted, longshots down,
 *     proven leagues up) — surfaced via credible_score for the frontend
 *   • both clubs must match the model's state bundle, else skip (no
 *     defaults-only guessing)
 *
 * Gated behind LAMBDA_BOARD_ENABLED (default false) for rollout control.
 * Run order: after ingestOdds.js, alongside computeValues.js.
 */
'use strict';

const { getClient } = require('./lib/supabaseClient');
const { priceFixture, available } = require('./lib/lambdaBoard');
const { categoryFor } = require('./lib/signalTier');

const ENABLED = process.env.LAMBDA_BOARD_ENABLED === 'true';
const EV_THRESHOLD = parseFloat(process.env.LAMBDA_EV_THRESHOLD || '0.03');
const ODDS_MAX_AGE_HOURS = parseFloat(process.env.ODDS_MAX_AGE_HOURS || '2');
const DEDUP_MINUTES = parseInt(process.env.SIGNAL_DEDUP_MINUTES || '60', 10);

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

/** Consensus (median) and best price per outcome from fresh h2h odds rows. */
function summariseOdds(rows) {
  const per = { home: [], draw: [], away: [] };
  for (const o of rows) {
    if (o.market && o.market !== 'h2h') continue;
    if (o.home_odds > 1) per.home.push({ v: parseFloat(o.home_odds), b: o.bookmaker });
    if (o.draw_odds > 1) per.draw.push({ v: parseFloat(o.draw_odds), b: o.bookmaker });
    if (o.away_odds > 1) per.away.push({ v: parseFloat(o.away_odds), b: o.bookmaker });
  }
  const med = a => {
    if (!a.length) return null;
    const s = a.map(x => x.v).sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const best = a => a.length ? a.reduce((m, x) => (x.v > m.v ? x : m)) : null;
  const out = {};
  for (const k of ['home', 'draw', 'away']) {
    out[k] = { median: med(per[k]), best: best(per[k]), n: per[k].length };
  }
  return out;
}

async function fetchFixtures(supabase) {
  const { data: matches, error } = await supabase
    .from('matches')
    .select(`
      id, kickoff_at, status,
      home_team:teams!matches_home_team_id_fkey ( id, name ),
      away_team:teams!matches_away_team_id_fkey ( id, name ),
      league:leagues ( id, name, country )
    `)
    .eq('status', 'scheduled')
    .order('kickoff_at', { ascending: true });
  if (error) throw new Error(`modelBoard[matches]: ${error.message}`);
  if (!matches?.length) return [];

  const freshCutoff = new Date(Date.now() - ODDS_MAX_AGE_HOURS * 3_600_000).toISOString();
  const odds = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await supabase
      .from('odds')
      .select('match_id, bookmaker, market, home_odds, draw_odds, away_odds, fetched_at')
      .gte('fetched_at', freshCutoff)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (e) throw new Error(`modelBoard[odds]: ${e.message}`);
    if (!data?.length) break;
    odds.push(...data);
    if (data.length < 1000) break;
  }
  const byMatch = new Map();
  for (const o of odds) {
    if (!byMatch.has(o.match_id)) byMatch.set(o.match_id, []);
    byMatch.get(o.match_id).push(o);
  }
  return matches
    .map(m => ({ ...m, oddsRows: byMatch.get(m.id) ?? [] }))
    .filter(m => m.oddsRows.length > 0);
}

async function run() {
  if (!ENABLED) {
    console.log('[modelBoard] LAMBDA_BOARD_ENABLED != true — skipping');
    return;
  }
  if (!available()) {
    console.log('[modelBoard] lambda model artifacts missing — skipping');
    return;
  }
  const supabase = getClient();
  const fixtures = await fetchFixtures(supabase);
  console.log(`[modelBoard] ${fixtures.length} scheduled fixtures with fresh odds`);

  const candidates = [];
  let skippedUnmatched = 0, skippedLeague = 0, priced = 0;
  let skippedNoKickoff = 0, skippedPast = 0;
  const unmappedLeagues = new Map();

  for (const m of fixtures) {
    // A null kickoff means the match row is a stub, not a real fixture. Left to
    // the comparison below it would read as the 1970 epoch — i.e. always "past
    // kickoff" — and vanish silently. Count it: a large number here means
    // something upstream is writing matches without a kickoff time, which is
    // exactly how this board sat at zero signals while looking healthy.
    if (!m.kickoff_at) { skippedNoKickoff++; continue; }
    if (new Date(m.kickoff_at) <= new Date()) { skippedPast++; continue; }
    const leagueKey = mapLeague(m.league?.name, m.league?.country);
    if (!leagueKey) {
      skippedLeague++;
      const n = [m.league?.name, m.league?.country].filter(Boolean).join(' / ') || '(no league)';
      unmappedLeagues.set(n, (unmappedLeagues.get(n) ?? 0) + 1);
      continue;
    }
    const s = summariseOdds(m.oddsRows);
    if (!(s.home.median > 1 && s.draw.median > 1 && s.away.median > 1)) continue;

    const res = await priceFixture({
      homeName: m.home_team?.name, awayName: m.away_team?.name, leagueKey,
      odds: { home: s.home.median, draw: s.draw.median, away: s.away.median },
    });
    if (!res) continue;
    if (!res.matched.home || !res.matched.away) { skippedUnmatched++; continue; }
    priced++;

    for (const opp of res.opportunities) {
      // Re-evaluate the edge at the BEST live price (median anchored the model).
      const bestP = s[opp.outcome]?.best;
      if (!bestP || !(bestP.v > 1)) continue;
      const edge = opp.modelP * bestP.v - 1;
      if (edge < EV_THRESHOLD || edge > 0.25) continue;
      candidates.push({
        match_id: m.id,
        kickoff_at: m.kickoff_at,
        market: 'h2h',
        outcome: opp.outcome,
        detected_odds: Number(bestP.v.toFixed(3)),
        detected_edge: Number(edge.toFixed(4)),
        bookmaker: bestP.b ?? null,
        model_architecture: 'LAMBDA_MC',
        phase: 'prematch',
        model_prob: opp.modelP,
        market_prob: Number(opp.marketP.toFixed(4)),
        credible_score: Number((edge *
          (opp.seg === 'fav' ? 1 : opp.seg === 'mid' ? 0.85 : 0.35) *
          (opp.leagueTag === 'proven' ? 1 : opp.leagueTag === 'avoid' ? 0.4 : 0.75)).toFixed(4)),
        league_tag: opp.leagueTag,
        price_seg: opp.seg,
        signal_category: categoryFor({ odds: bestP.v, edge }),
      });
    }
  }
  console.log(`[modelBoard] priced=${priced} no_kickoff=${skippedNoKickoff} ` +
              `past=${skippedPast} skipped_league=${skippedLeague} ` +
              `skipped_unmatched=${skippedUnmatched} candidates=${candidates.length}`);
  if (unmappedLeagues.size) {
    // Naming the leagues we threw away turns "the board is empty" into a
    // one-line diagnosis — add a LEAGUE_PATTERNS entry or fix the upstream row.
    const top = [...unmappedLeagues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`[modelBoard] unmapped leagues: ` +
                top.map(([n, c]) => `${n} (${c})`).join(', '));
  }
  if (!candidates.length) return;

  // Dedup: skip if the same selection was signalled at ~the same price recently.
  const cutoff = new Date(Date.now() - DEDUP_MINUTES * 60_000).toISOString();
  const { data: recent, error: selErr } = await supabase
    .from('value_signals')
    .select('match_id, outcome, detected_odds')
    .eq('model_architecture', 'LAMBDA_MC')
    .in('match_id', [...new Set(candidates.map(c => c.match_id))])
    .gte('detected_at', cutoff);
  if (selErr) throw new Error(`modelBoard[dedup]: ${selErr.message}`);
  const seen = new Set((recent ?? []).map(r =>
    `${r.match_id}|${r.outcome}|${parseFloat(r.detected_odds).toFixed(3)}`));
  const toInsert = candidates.filter(c =>
    !seen.has(`${c.match_id}|${c.outcome}|${c.detected_odds.toFixed(3)}`));

  console.log(`[modelBoard] inserting ${toInsert.length} (deduped ${candidates.length - toInsert.length})`);
  if (!toInsert.length) return;
  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`modelBoard[insert]: ${insErr.message}`);
  console.log('[modelBoard] done');
}

if (require.main === module) {
  run().catch(err => { console.error('[modelBoard] FATAL:', err.message); process.exit(1); });
}

module.exports = { run, mapLeague, summariseOdds };
