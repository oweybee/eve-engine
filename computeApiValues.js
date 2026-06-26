'use strict';

/**
 * EVE — API Predictive Value Engine  v1
 *
 * Model: API_PREDICTIVE
 *   Sources win probabilities from match_predictions (populated by
 *   fetchMatchDetails.js via the API-Football /predictions endpoint).
 *
 * Core logic:
 *   p_api     = match_predictions.pct_home / pct_draw / pct_away  (stored as "0.5500" TEXT)
 *   fair_odds = 1 / p_api  (no alpha — systematic bias not yet calibrated)
 *   has_edge  = max_odds > fair_odds
 *   edge      = p_api * max_odds - 1
 *
 * Coexistence: uses UNIQUE(match_id, model_architecture) — never overwrites
 * MARKET_CONSENSUS rows.
 */

const { getClient } = require('./lib/supabaseClient');

const MIN_BOOKMAKERS      = parseInt(process.env.MIN_BOOKMAKERS      || '3',  10);
const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY || '5',  10);
const EV_THRESHOLD        = parseFloat(process.env.EV_THRESHOLD       || '0.02');

// ── 1. Fetch matches with odds + predictions ──────────────────────────────────

async function fetchMatchesForApiComputation(supabase) {
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

  if (matchError) throw new Error(`fetchMatchesForApiComputation[matches]: ${matchError.message}`);
  if (!matchData?.length) return [];

  const matchIds    = matchData.map(m => m.id);
  const externalIds = matchData.map(m => m.external_id).filter(Boolean);

  const [oddsResult, predResult] = await Promise.all([
    supabase
      .from('odds')
      .select('match_id, bookmaker, market, home_odds, draw_odds, away_odds, fetched_at')
      .in('match_id', matchIds),
    supabase
      .from('match_predictions')
      .select('fixture_id, pct_home, pct_draw, pct_away, advice, winner_team')
      .in('fixture_id', externalIds),
  ]);

  if (oddsResult.error) throw new Error(`fetchMatchesForApiComputation[odds]: ${oddsResult.error.message}`);
  if (predResult.error) throw new Error(`fetchMatchesForApiComputation[preds]: ${predResult.error.message}`);

  const oddsByMatch = {};
  for (const o of (oddsResult.data ?? [])) {
    if (!oddsByMatch[o.match_id]) oddsByMatch[o.match_id] = [];
    oddsByMatch[o.match_id].push(o);
  }

  const predByExternal = {};
  for (const p of (predResult.data ?? [])) {
    predByExternal[p.fixture_id] = p;
  }

  return matchData
    .map(m => ({
      ...m,
      odds:       oddsByMatch[m.id] ?? [],
      prediction: predByExternal[m.external_id] ?? null,
    }))
    .filter(m => m.odds.length > 0 && m.prediction !== null);
}

// ── 2. Bookmaker display names ─────────────────────────────────────────────────

function formatBookName(key) {
  if (!key) return null;
  const names = {
    betfair_ex_uk: 'Betfair Exch', betfair_sb_uk: 'Betfair SB', smarkets: 'Smarkets',
    matchbook: 'Matchbook', bet365: 'Bet365', skybet: 'Sky Bet',
    williamhill: 'William Hill', paddypower: 'Paddy Power', coral: 'Coral',
    ladbrokes_uk: 'Ladbrokes', betfred_uk: 'Betfred', betway: 'Betway',
    betvictor: 'BetVictor', boylesports: 'BoyleSports', unibet_uk: 'Unibet',
    virginbet: 'Virgin Bet', sport888: '888sport', leovegas: 'LeoVegas',
    casumo: 'Casumo', grosvenor: 'Grosvenor', livescorebet: 'LiveScore Bet',
    pinnacle: 'Pinnacle', unibet: 'Unibet', betsson: 'Betsson',
  };
  return names[key] ?? key;
}

// ── 3. Compute edge for one match ─────────────────────────────────────────────

function computeApiMatchEdge(match) {
  const { prediction } = match;
  if (!prediction) return { skipped: true };

  const h2hRows = match.odds.filter(r => (r.market ?? 'h2h') === 'h2h');
  if (!h2hRows.length) return { skipped: true };

  const byBook = new Map();
  for (const row of h2hRows) {
    const existing = byBook.get(row.bookmaker);
    if (!existing || row.fetched_at > existing.fetched_at) {
      byBook.set(row.bookmaker, row);
    }
  }
  if (byBook.size < MIN_BOOKMAKERS) return { skipped: true };

  const deduped = [...byBook.values()];
  const latestFetchedAt = deduped.reduce(
    (best, r) => (!best || r.fetched_at > best ? r.fetched_at : best), null,
  );

  const p_home = parseFloat(prediction.pct_home);
  const p_draw = parseFloat(prediction.pct_draw);
  const p_away = parseFloat(prediction.pct_away);

  if (!Number.isFinite(p_home) || !Number.isFinite(p_draw) || !Number.isFinite(p_away)) {
    return { skipped: true };
  }

  const OUTCOMES = ['home', 'draw', 'away'];
  const FIELDS   = { home: 'home_odds', draw: 'draw_odds', away: 'away_odds' };
  const P_API    = { home: p_home, draw: p_draw, away: p_away };

  const outcomeResults = {};

  for (const outcome of OUTCOMES) {
    const field = FIELDS[outcome];
    const p_api = P_API[outcome];

    if (p_api <= 0 || p_api > 1) {
      outcomeResults[outcome] = null;
      continue;
    }

    const validRows = deduped.filter(r => {
      const v = parseFloat(r[field]);
      return Number.isFinite(v) && v > 1.0 && v < 1000;
    });
    if (!validRows.length) {
      outcomeResults[outcome] = null;
      continue;
    }

    const allOdds = {};
    for (const r of validRows) {
      const name = formatBookName(r.bookmaker);
      if (name) allOdds[name] = parseFloat(r[field]);
    }

    let max_odds = 0;
    let max_book = null;
    for (const r of validRows) {
      const v = parseFloat(r[field]);
      if (v > max_odds) { max_odds = v; max_book = formatBookName(r.bookmaker); }
    }

    const fair_odds = 1 / p_api;
    const has_edge  = max_odds > fair_odds;
    const edge      = has_edge ? parseFloat((p_api * max_odds - 1).toFixed(6)) : 0;

    outcomeResults[outcome] = { p_api, fair_odds, max_odds, max_book, has_edge, edge, allOdds };
  }

  const { home, draw, away } = outcomeResults;

  const home_edge = home?.has_edge ? home.edge : 0;
  const draw_edge = draw?.has_edge ? draw.edge : 0;
  const away_edge = away?.has_edge ? away.edge : 0;

  const home_value = !!(home?.has_edge && home.edge >= EV_THRESHOLD);
  const draw_value = !!(draw?.has_edge && draw.edge >= EV_THRESHOLD);
  const away_value = !!(away?.has_edge && away.edge >= EV_THRESHOLD);

  const edgeMap    = { home: home_edge, draw: draw_edge, away: away_edge };
  const best_outcome = Object.entries(edgeMap).reduce(
    (best, [k, v]) => (v > edgeMap[best] ? k : best), 'home',
  );
  const max_edge_val = Math.max(home_edge, draw_edge, away_edge);

  const row = {
    match_id: match.id,

    best_home_odds: home?.max_odds  ?? null,
    best_draw_odds: draw?.max_odds  ?? null,
    best_away_odds: away?.max_odds  ?? null,
    best_home_book: home?.max_book  ?? null,
    best_draw_book: draw?.max_book  ?? null,
    best_away_book: away?.max_book  ?? null,

    fair_home_odds: home?.fair_odds != null ? String(home.fair_odds.toFixed(4)) : null,
    fair_draw_odds: draw?.fair_odds != null ? String(draw.fair_odds.toFixed(4)) : null,
    fair_away_odds: away?.fair_odds != null ? String(away.fair_odds.toFixed(4)) : null,

    home_edge, draw_edge, away_edge,
    home_value, draw_value, away_value,

    model_architecture: 'API_PREDICTIVE',
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
    _bookmakerCount: deduped.length,
  };

  return { skipped: false, row, hasValue: home_value || draw_value || away_value };
}

// ── 4. Upsert computed_values ─────────────────────────────────────────────────

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

// ── 5. Insert value_signals (2-hour dedup, shared across architectures) ────────

async function insertValueSignals(supabase, rows) {
  const candidates = [];

  for (const row of rows) {
    for (const outcome of ['home', 'draw', 'away']) {
      if (!row[`${outcome}_value`]) continue;

      const edge = row[`${outcome}_edge`];

      const fairOddsStr = row[`fair_${outcome}_odds`];
      const p_api = fairOddsStr ? 1 / parseFloat(fairOddsStr) : null;
      const isSweet = edge >= 0.05 && edge <= 0.25;
      const signal_category = isSweet && (p_api ?? 0) >= 0.15
        ? 'Prime'
        : isSweet
        ? 'Longshot Edge'
        : 'Standard';

      candidates.push({
        match_id:           row.match_id,
        outcome,
        detected_odds:      row[`best_${outcome}_odds`],
        detected_edge:      edge,
        detected_mes:       null,
        bookmaker:          row[`best_${outcome}_book`],
        kickoff_at:         row._kickoff_at ?? null,
        signal_category,
        model_architecture: 'API_PREDICTIVE',
      });
    }
  }

  if (!candidates.length) {
    console.log('[api_engine] no value outcomes to record');
    return 0;
  }

  const primeCount = candidates.filter(c => c.signal_category === 'Prime').length;
  console.log(`[api_engine] value_signals candidates: ${candidates.length} (Prime: ${primeCount})`);

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
    console.log(`[api_engine] all ${candidates.length} signal(s) deduped within 2h — skipping`);
    return 0;
  }

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);

  console.log(
    `[api_engine] recorded ${toInsert.length} new signal(s)` +
    ` (${candidates.length - toInsert.length} skipped as 2h dupes)`
  );
  return toInsert.length;
}

// ── 6. Concurrency pool ───────────────────────────────────────────────────────

async function withPool(items, fn, concurrency) {
  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch   = items.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else {
        console.error('[api_engine] match error:', s.reason?.message ?? s.reason);
        results.push(null);
      }
    }
  }
  return results;
}

// ── 7. Main ───────────────────────────────────────────────────────────────────

async function main() {
  const supabase = getClient();

  console.log('[api_engine] computeApiValues v1 — API Predictive (API-Football /predictions)');
  console.log(`[api_engine] min_books=${MIN_BOOKMAKERS} ev_threshold=${EV_THRESHOLD} pool=${COMPUTE_CONCURRENCY}`);

  const matches = await fetchMatchesForApiComputation(supabase);
  if (!matches.length) {
    console.log('[api_engine] no matches with both odds and predictions — nothing to compute');
    return;
  }

  console.log(`[api_engine] processing ${matches.length} match(es) with predictions`);

  const results = await withPool(matches, computeApiMatchEdge, COMPUTE_CONCURRENCY);

  let computed = 0, skipped = 0, value = 0;
  const computedRows = [];
  const valueRows    = [];

  for (const res of results) {
    if (!res || res.skipped) { skipped++; continue; }
    computed++;
    computedRows.push(res.row);
    if (res.hasValue) { value++; valueRows.push(res.row); }
  }

  console.log(`[api_engine] computed=${computed} skipped=${skipped} value=${value}`);
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
      .eq('model_architecture', 'API_PREDICTIVE');
    if (swErr) console.error('[api_engine] signals_written update error:', swErr.message);
  }
}

main().catch(err => {
  console.error('[api_engine] fatal:', err.message);
  process.exit(1);
});
