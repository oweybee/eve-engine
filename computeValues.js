'use strict';

/**
 * EVE — Value Detection Engine  v6
 *
 * Model: Market Consensus / Wisdom of Crowds (Kaunitz et al.)
 *        "Beating the bookies with their own numbers" (2017)
 *
 * Core logic:
 *   1. Collect all bookmaker odds for a fixture (h2h market only).
 *   2. Compute consensus probability: p_cons = 1 / mean(all_odds_for_outcome)
 *   3. Subtract directional margin alpha to isolate true probability:
 *        p_adj = p_cons - alpha
 *   4. Fair odds line: fair_odds = 1 / p_adj
 *   5. Edge exists when any bookmaker beats the fair line:
 *        has_edge = max_odds > fair_odds
 *        edge     = p_adj * max_odds - 1
 *
 * Alpha constants (Kaunitz et al., Table 3):
 *   alpha_home = 0.034  alpha_draw = 0.057  alpha_away = 0.037
 *   Set env var USE_UNIFORM_ALPHA=true to use alpha=0.05 for all outcomes
 *   (paper's real-world trading optimisation variant).
 *
 * Guard: fixtures with fewer than MIN_BOOKMAKERS (3) are skipped to prevent
 * low-sample consensus distortion.
 */

const { getClient } = require('./lib/supabaseClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MIN_BOOKMAKERS      = parseInt(process.env.MIN_BOOKMAKERS      || '3',    10);
const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY || '5',    10);
const USE_UNIFORM_ALPHA   = (process.env.USE_UNIFORM_ALPHA || '').toLowerCase() === 'true';

// Directional alphas (Kaunitz et al.)
const ALPHA_HOME    = parseFloat(process.env.ALPHA_HOME    || '0.034');
const ALPHA_DRAW    = parseFloat(process.env.ALPHA_DRAW    || '0.057');
const ALPHA_AWAY    = parseFloat(process.env.ALPHA_AWAY    || '0.037');
const ALPHA_UNIFORM = parseFloat(process.env.ALPHA_UNIFORM || '0.05');

// Minimum raw edge to write a value_signal row (keeps noise out of DB)
const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD || '0.02');

// ---------------------------------------------------------------------------
// 1. Fetch matches with odds
// ---------------------------------------------------------------------------

async function fetchMatchesForComputation(supabase) {
  const { data: matchData, error: matchError } = await supabase
    .from('matches')
    .select(`
      id, external_id, kickoff_at, status,
      home_team:teams!matches_home_team_id_fkey ( id, name ),
      away_team:teams!matches_away_team_id_fkey ( id, name ),
      league:leagues ( id, name )
    `)
    .in('status', ['scheduled', 'live'])
    .order('kickoff_at', { ascending: true });

  if (matchError) throw new Error(`fetchMatchesForComputation[matches]: ${matchError.message}`);
  if (!matchData?.length) return [];

  const matchIds = matchData.map(m => m.id);

  const { data: oddsData, error: oddsError } = await supabase
    .from('odds')
    .select('match_id, bookmaker, market, home_odds, draw_odds, away_odds, fetched_at')
    .in('match_id', matchIds);

  if (oddsError) throw new Error(`fetchMatchesForComputation[odds]: ${oddsError.message}`);

  const oddsByMatch = {};
  for (const o of (oddsData ?? [])) {
    if (!oddsByMatch[o.match_id]) oddsByMatch[o.match_id] = [];
    oddsByMatch[o.match_id].push(o);
  }

  return matchData
    .map(m => ({ ...m, odds: oddsByMatch[m.id] ?? [] }))
    .filter(m => m.odds.length > 0);
}

// ---------------------------------------------------------------------------
// 2. Bookmaker display names
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
// 3. Market consensus engine (Kaunitz et al.)
// ---------------------------------------------------------------------------

function computeConsensus(oddsRows) {
  const h2hRows = oddsRows.filter(r => (r.market ?? 'h2h') === 'h2h');
  if (!h2hRows.length) return null;

  const byBook = new Map();
  for (const row of h2hRows) {
    const existing = byBook.get(row.bookmaker);
    if (!existing || row.fetched_at > existing.fetched_at) {
      byBook.set(row.bookmaker, row);
    }
  }

  if (byBook.size < MIN_BOOKMAKERS) return null;

  const deduped = [...byBook.values()];
  const bookmakerCount = deduped.length;

  const latestFetchedAt = deduped.reduce(
    (best, r) => (!best || r.fetched_at > best ? r.fetched_at : best), null
  );

  const OUTCOMES = ['home', 'draw', 'away'];
  const FIELDS   = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };
  const ALPHAS   = {
    home: USE_UNIFORM_ALPHA ? ALPHA_UNIFORM : ALPHA_HOME,
    draw: USE_UNIFORM_ALPHA ? ALPHA_UNIFORM : ALPHA_DRAW,
    away: USE_UNIFORM_ALPHA ? ALPHA_UNIFORM : ALPHA_AWAY,
  };

  const result = { bookmakerCount, latestFetchedAt };

  for (const outcome of OUTCOMES) {
    const field = FIELDS[outcome];
    const alpha = ALPHAS[outcome];

    const validRows = deduped.filter(r => {
      const v = parseFloat(r[field]);
      return Number.isFinite(v) && v > 1.0 && v < 1000;
    });

    if (!validRows.length) {
      result[outcome] = null;
      continue;
    }

    const allOdds = {};
    for (const r of validRows) {
      const v    = parseFloat(r[field]);
      const name = formatBookName(r.bookmaker);
      if (name) allOdds[name] = v;
    }

    const oddsValues = validRows.map(r => parseFloat(r[field]));
    const meanOdds   = oddsValues.reduce((s, v) => s + v, 0) / oddsValues.length;
    const p_cons     = 1 / meanOdds;
    const p_adj      = p_cons - alpha;

    if (p_adj <= 0) {
      result[outcome] = { p_cons, p_adj: null, has_edge: false, allOdds };
      continue;
    }

    const fair_odds = 1 / p_adj;

    let max_odds = 0;
    let max_book = null;
    for (const r of validRows) {
      const v = parseFloat(r[field]);
      if (v > max_odds) { max_odds = v; max_book = formatBookName(r.bookmaker); }
    }

    const has_edge = max_odds > fair_odds;
    const edge     = has_edge ? parseFloat((p_adj * max_odds - 1).toFixed(6)) : 0;

    result[outcome] = { p_cons, p_adj, fair_odds, max_odds, max_book, has_edge, edge, allOdds };
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. Build computed_values row for one match
// ---------------------------------------------------------------------------

function computeMatch(match) {
  const consensus = computeConsensus(match.odds);
  if (!consensus) return { skipped: true };

  const { home, draw, away, bookmakerCount, latestFetchedAt } = consensus;

  const best_home_odds = home?.max_odds  ?? null;
  const best_draw_odds = draw?.max_odds  ?? null;
  const best_away_odds = away?.max_odds  ?? null;
  const best_home_book = home?.max_book  ?? null;
  const best_draw_book = draw?.max_book  ?? null;
  const best_away_book = away?.max_book  ?? null;

  const fair_home_odds = home?.fair_odds != null ? String(home.fair_odds.toFixed(4)) : null;
  const fair_draw_odds = draw?.fair_odds != null ? String(draw.fair_odds.toFixed(4)) : null;
  const fair_away_odds = away?.fair_odds != null ? String(away.fair_odds.toFixed(4)) : null;

  const home_edge = home?.has_edge ? home.edge : 0;
  const draw_edge = draw?.has_edge ? draw.edge : 0;
  const away_edge = away?.has_edge ? away.edge : 0;

  const home_value = !!(home?.has_edge && home.edge >= EV_THRESHOLD);
  const draw_value = !!(draw?.has_edge && draw.edge >= EV_THRESHOLD);
  const away_value = !!(away?.has_edge && away.edge >= EV_THRESHOLD);

  const edgeMap    = { home: home_edge, draw: draw_edge, away: away_edge };
  const best_outcome = Object.entries(edgeMap).reduce(
    (best, [k, v]) => (v > edgeMap[best] ? k : best), 'home'
  );
  const max_edge_val = Math.max(home_edge, draw_edge, away_edge);

  const row = {
    match_id: match.id,

    best_home_odds,
    best_draw_odds,
    best_away_odds,
    best_home_book,
    best_draw_book,
    best_away_book,

    fair_home_odds,
    fair_draw_odds,
    fair_away_odds,

    home_edge,
    draw_edge,
    away_edge,

    home_value,
    draw_value,
    away_value,

    model_architecture: 'MARKET_CONSENSUS',
    odds_fetched_at:    latestFetchedAt,
    computed_at:        new Date().toISOString(),

    best_outcome:  max_edge_val > 0 ? best_outcome : null,
    ev_per_unit:   max_edge_val > 0 ? parseFloat(max_edge_val.toFixed(6)) : null,

    all_home_odds: home?.allOdds ?? null,
    all_draw_odds: draw?.allOdds ?? null,
    all_away_odds: away?.allOdds ?? null,

    over_edge: null, under_edge: null, over_value: false, under_value: false,
    btts_yes_edge: null, btts_no_edge: null, btts_yes_value: false, btts_no_value: false,
    bookings_over_edge: null, bookings_under_edge: null,
    bookings_over_value: false, bookings_under_value: false,
    corners_over_edge: null, corners_under_edge: null,
    corners_over_value: false, corners_under_value: false,

    _kickoff_at:     match.kickoff_at,
    _bookmakerCount: bookmakerCount,
  };

  return { skipped: false, row, hasValue: home_value || draw_value || away_value };
}

// ---------------------------------------------------------------------------
// 5. Upsert computed_values
// ---------------------------------------------------------------------------

async function upsertComputedValues(supabase, rows) {
  if (!rows.length) return new Map();

  const dbRows = rows.map(row => {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('_') && k !== 'signals_written') clean[k] = v;
    }
    return clean;
  });

  const { data, error } = await supabase
    .from('computed_values')
    .upsert(dbRows, { onConflict: 'match_id,model_architecture' })
    .select('match_id, signals_written');

  if (error) throw new Error(`upsertComputedValues: ${error.message}`);
  return new Map((data ?? []).map(r => [r.match_id, r.signals_written === true]));
}

// ---------------------------------------------------------------------------
// 6. Insert value_signals (2-hour dedup)
// ---------------------------------------------------------------------------

async function insertValueSignals(supabase, rows) {
  const candidates = [];

  for (const row of rows) {
    for (const outcome of ['home', 'draw', 'away']) {
      if (!row[`${outcome}_value`]) continue;

      const edge = row[`${outcome}_edge`];
      const signal_category = edge >= 0.05 ? 'Prime' : 'Standard';

      candidates.push({
        match_id:           row.match_id,
        outcome,
        detected_odds:      row[`best_${outcome}_odds`],
        detected_edge:      edge,
        detected_mes:       null,
        bookmaker:          row[`best_${outcome}_book`],
        kickoff_at:         row._kickoff_at ?? null,
        signal_category,
        model_architecture: 'MARKET_CONSENSUS',
      });
    }
  }

  if (!candidates.length) {
    console.log('[value_signals] no value outcomes to record');
    return 0;
  }

  const primeCount    = candidates.filter(c => c.signal_category === 'Prime').length;
  const standardCount = candidates.filter(c => c.signal_category === 'Standard').length;
  console.log(`[value_signals] candidates — Prime:${primeCount} Standard:${standardCount}`);

  const matchIds    = [...new Set(candidates.map(c => c.match_id))];
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: recent, error: selErr } = await supabase
    .from('value_signals')
    .select('match_id, outcome')
    .in('match_id', matchIds)
    .gte('detected_at', twoHoursAgo);
  if (selErr) throw new Error(`insertValueSignals(select): ${selErr.message}`);

  const seen     = new Set((recent ?? []).map(r => `${r.match_id}|${r.outcome}`));
  const toInsert = candidates.filter(c => !seen.has(`${c.match_id}|${c.outcome}`));

  if (!toInsert.length) {
    console.log(`[value_signals] all ${candidates.length} signal(s) already recorded within 2h — skipping`);
    return 0;
  }

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);

  console.log(
    `[value_signals] recorded ${toInsert.length} new signal(s)` +
    ` (${candidates.length - toInsert.length} skipped as duplicates within 2h)`
  );
  return toInsert.length;
}

// ---------------------------------------------------------------------------
// 7. Bet-of-day (highest-edge match)
// ---------------------------------------------------------------------------

async function updateBetOfDay(supabase, rows) {
  await supabase.from('matches').update({ is_bet_of_day: false }).eq('is_bet_of_day', true);

  const candidates = rows.filter(r =>
    Math.max(r.home_edge ?? 0, r.draw_edge ?? 0, r.away_edge ?? 0) > 0
  );
  if (!candidates.length) return null;

  const best = candidates.reduce((top, r) => {
    const e    = Math.max(r.home_edge ?? 0, r.draw_edge ?? 0, r.away_edge ?? 0);
    const topE = Math.max(top.home_edge ?? 0, top.draw_edge ?? 0, top.away_edge ?? 0);
    return e > topE ? r : top;
  });

  await supabase.from('matches').update({ is_bet_of_day: true }).eq('id', best.match_id);
  return best.match_id;
}

// ---------------------------------------------------------------------------
// 8. Concurrency pool
// ---------------------------------------------------------------------------

async function withPool(items, fn, concurrency) {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError(`COMPUTE_CONCURRENCY must be >= 1, got ${concurrency}`);
  }

  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch   = items.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        console.error('[engine] match error:', s.reason?.message ?? s.reason);
        results.push(null);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = getClient();

  console.log('[engine] computeValues v6 — Market Consensus (Kaunitz et al.)');
  console.log(
    `[engine] alpha_mode=${USE_UNIFORM_ALPHA ? `uniform(${ALPHA_UNIFORM})` : 'directional'}` +
    ` min_books=${MIN_BOOKMAKERS} ev_threshold=${EV_THRESHOLD} pool=${COMPUTE_CONCURRENCY}`
  );

  const matches = await fetchMatchesForComputation(supabase);
  if (!matches.length) {
    console.log('[engine] no matches with odds — nothing to compute');
    return;
  }

  console.log(`[engine] processing ${matches.length} match(es) (pool=${COMPUTE_CONCURRENCY})`);

  const results = await withPool(matches, computeMatch, COMPUTE_CONCURRENCY);

  let computed = 0, skipped = 0, value = 0;
  const computedRows = [];
  const valueRows    = [];

  for (const res of results) {
    if (!res || res.skipped) { skipped++; continue; }
    computed++;
    computedRows.push(res.row);
    if (res.hasValue) { value++; valueRows.push(res.row); }
  }

  console.log(`[engine] computed=${computed} skipped=${skipped} value=${value}`);

  if (!computedRows.length) return;

  const signalsWrittenMap = await upsertComputedValues(supabase, computedRows);

  const unsignaled = valueRows.filter(r => signalsWrittenMap.get(r.match_id) !== true);
  if (unsignaled.length) {
    await insertValueSignals(supabase, unsignaled);

    const matchIds = unsignaled.map(r => r.match_id);
    const { error: swErr } = await supabase
      .from('computed_values')
      .update({ signals_written: true })
      .in('match_id', matchIds)
      .eq('model_architecture', 'MARKET_CONSENSUS');
    if (swErr) console.error('[engine] signals_written update error:', swErr.message);
  }

  await updateBetOfDay(supabase, computedRows);

  if (USE_UNIFORM_ALPHA) {
    console.log(`[engine] alpha=uniform(${ALPHA_UNIFORM})`);
  } else {
    console.log(`[engine] alpha=directional home=${ALPHA_HOME} draw=${ALPHA_DRAW} away=${ALPHA_AWAY}`);
  }
}

main().catch(err => {
  console.error('[engine] fatal:', err.message);
  process.exit(1);
});
