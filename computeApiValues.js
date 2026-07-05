'use strict';

/**
 * EVE — API Predictive Value Engine  v3
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
 * v2 changes (parity with computeValues.js v7):
 *   - Removed signals_written gate; odds-hash dedup; EV_THRESHOLD 0.005; MIN_BOOKMAKERS 2
 *
 * v3 fail-safe guards (diagnosed from live engine logs):
 *   - ODDS_MAX_AGE_HOURS: skip matches whose newest odds are stale, so we never
 *     compare fresh predictions against stale prices (was producing 200%+ edges).
 *   - Require home+draw+away best odds all present before emitting a row — the
 *     computed_values best_*_odds columns are NOT NULL; writing null aborted the
 *     whole batch upsert and killed every API_PREDICTIVE row.
 *   - MAX_PLAUSIBLE_EDGE (default 0.15): reject implausibly large edges. API-Football
 *     /predictions percentages are coarse (45-50% draw buckets) and manufacture
 *     phantom edges, so only modest edges are treated as genuine value.
 *
 * Coexistence: uses UNIQUE(match_id, model_architecture) — never overwrites
 * MARKET_CONSENSUS rows.
 */

const { getClient } = require('./lib/supabaseClient');
const { categoryFor } = require('./lib/signalTier');

const MIN_BOOKMAKERS        = parseInt(process.env.MIN_BOOKMAKERS        || '2',  10);
const COMPUTE_CONCURRENCY   = parseInt(process.env.COMPUTE_CONCURRENCY   || '5',  10);
const EV_THRESHOLD          = parseFloat(process.env.EV_THRESHOLD         || '0.005');
const SIGNAL_DEDUP_MINUTES  = parseInt(process.env.SIGNAL_DEDUP_MINUTES  || '60', 10);
const ODDS_MAX_AGE_HOURS    = parseFloat(process.env.ODDS_MAX_AGE_HOURS   || '24');
const MAX_PLAUSIBLE_EDGE    = parseFloat(process.env.MAX_PLAUSIBLE_EDGE   || '0.15');

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

  // Odds is a snapshot history — a plain .in() is capped at 1000 rows by
  // PostgREST and silently truncated the slate so most matches got no odds.
  // Restrict to the freshness window and page through in 1000-row chunks.
  const freshCutoff = new Date(Date.now() - ODDS_MAX_AGE_HOURS * 3_600_000).toISOString();
  const fetchAllOdds = async () => {
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('odds')
        .select('match_id, bookmaker, market, home_odds, draw_odds, away_odds, fetched_at')
        .in('match_id', matchIds)
        .gte('fetched_at', freshCutoff)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`fetchMatchesForApiComputation[odds]: ${error.message}`);
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    return rows;
  };

  const [oddsData, predResult] = await Promise.all([
    fetchAllOdds(),
    supabase
      .from('match_predictions')
      .select('fixture_id, pct_home, pct_draw, pct_away, advice, winner_team')
      .in('fixture_id', externalIds),
  ]);

  if (predResult.error) throw new Error(`fetchMatchesForApiComputation[preds]: ${predResult.error.message}`);

  const oddsByMatch = {};
  for (const o of oddsData) {
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

// ── 2. Bookmaker display names ────────────────────────────────────────────────

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

  // Stale-odds guard: do not compare fresh predictions against stale prices.
  const oddsAgeMs = latestFetchedAt
    ? Date.now() - new Date(latestFetchedAt).getTime()
    : Infinity;
  if (oddsAgeMs > ODDS_MAX_AGE_HOURS * 3_600_000) return { skipped: true, reason: 'stale_odds' };

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

  // computed_values.best_*_odds are NOT NULL. Only emit a row when all three
  // outcomes have a price — otherwise the batch upsert aborts on a null write.
  if (!home || !draw || !away) {
    return { skipped: true, reason: 'incomplete_h2h' };
  }

  // Implausible-edge guard: an edge above the cap signals an odds/prediction
  // mismatch (coarse API percentages), not genuine value. Clamp the STORED edge
  // to 0 — not just the value flag — so computed_values never holds a garbage
  // edge that would surface at the top of the Market Pulse board.
  const usable = (hasEdge, e) => (hasEdge && e <= MAX_PLAUSIBLE_EDGE ? e : 0);
  const home_edge = usable(home.has_edge, home.edge);
  const draw_edge = usable(draw.has_edge, draw.edge);
  const away_edge = usable(away.has_edge, away.edge);

  const home_value = home_edge >= EV_THRESHOLD;
  const draw_value = draw_edge >= EV_THRESHOLD;
  const away_value = away_edge >= EV_THRESHOLD;

  const edgeMap    = { home: home_edge, draw: draw_edge, away: away_edge };
  const best_outcome = Object.entries(edgeMap).reduce(
    (best, [k, v]) => (v > edgeMap[best] ? k : best), 'home',
  );
  const max_edge_val = Math.max(home_edge, draw_edge, away_edge);
  const max_edge_score = max_edge_val > 0 ? Math.min(100, Math.round(max_edge_val * 1000)) : 0;

  const row = {
    match_id: match.id,

    best_home_odds: home.max_odds,
    best_draw_odds: draw.max_odds,
    best_away_odds: away.max_odds,
    best_home_book: home.max_book,
    best_draw_book: draw.max_book,
    best_away_book: away.max_book,

    fair_home_odds: String(home.fair_odds.toFixed(4)),
    fair_draw_odds: String(draw.fair_odds.toFixed(4)),
    fair_away_odds: String(away.fair_odds.toFixed(4)),

    home_edge, draw_edge, away_edge,
    home_value, draw_value, away_value,

    model_architecture: 'API_PREDICTIVE',
    odds_fetched_at:    latestFetchedAt,
    computed_at:        new Date().toISOString(),

    best_outcome:  max_edge_val > 0 ? best_outcome : null,
    ev_per_unit:   max_edge_val > 0 ? parseFloat(max_edge_val.toFixed(6)) : null,
    max_edge_score,

    all_home_odds: home.allOdds ?? null,
    all_draw_odds: draw.allOdds ?? null,
    all_away_odds: away.allOdds ?? null,

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

// ── 4. Upsert computed_values ────────────────────────────────────────────────

async function upsertComputedValues(supabase, rows) {
  if (!rows.length) return;

  const dbRows = rows.map(row => {
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('_') && k !== 'signals_written') clean[k] = v;
    }
    return clean;
  });

  const { error } = await supabase
    .from('computed_values')
    .upsert(dbRows, { onConflict: 'match_id,model_architecture' });

  if (error) throw new Error(`upsertComputedValues: ${error.message}`);
}

// ── 5. Insert value_signals (odds-hash dedup within SIGNAL_DEDUP_MINUTES) ─────

async function insertValueSignals(supabase, rows) {
  const candidates = [];

  for (const row of rows) {
    for (const outcome of ['home', 'draw', 'away']) {
      if (!row[`${outcome}_value`]) continue;

      const edge = row[`${outcome}_edge`];
      const odds = row[`best_${outcome}_odds`];
      const fairOddsStr = row[`fair_${outcome}_odds`];
      const p_api = fairOddsStr ? 1 / parseFloat(fairOddsStr) : null;

      candidates.push({
        match_id:           row.match_id,
        outcome,
        detected_odds:      odds,
        detected_edge:      edge,
        detected_mes:       row.max_edge_score ?? null,
        bookmaker:          row[`best_${outcome}_book`],
        kickoff_at:         row._kickoff_at ?? null,
        model_architecture: 'API_PREDICTIVE',
        _edge:              edge,
        _odds:              odds,
        _p_api:             p_api,
      });
    }
  }

  if (!candidates.length) {
    console.log('[api_engine] no value outcomes to record');
    return 0;
  }

  const matchIds    = [...new Set(candidates.map(c => c.match_id))];
  const dedupCutoff = new Date(Date.now() - SIGNAL_DEDUP_MINUTES * 60 * 1000).toISOString();

  const { data: recent, error: selErr } = await supabase
    .from('value_signals')
    .select('match_id, outcome, detected_odds')
    .in('match_id', matchIds)
    .gte('detected_at', dedupCutoff);
  if (selErr) throw new Error(`insertValueSignals(select): ${selErr.message}`);

  const recentOdds = new Map();
  for (const r of (recent ?? [])) {
    recentOdds.set(`${r.match_id}|${r.outcome}`, parseFloat(r.detected_odds));
  }

  const toInsert = [];
  let skippedSamePrice = 0;

  for (const c of candidates) {
    const key      = `${c.match_id}|${c.outcome}`;
    const lastOdds = recentOdds.get(key);
    const curOdds  = parseFloat(c._odds);

    if (lastOdds != null && Math.abs(lastOdds - curOdds) < 0.001) {
      skippedSamePrice++;
      continue;
    }

    // Conviction tier from the canonical odds+edge ladder (the old prob-based
    // Prime/Longshot Edge split folds into the odds ≥ 3.00 Longshot bucket); a
    // re-detection at a shifted price is carried by is_mover.
    const is_mover = lastOdds != null;
    const signal_category = categoryFor({ odds: curOdds, edge: c._edge });

    const { _edge, _odds, _p_api, ...signalRow } = c;
    toInsert.push({ ...signalRow, signal_category, is_mover });
  }

  console.log(
    `[api_engine] candidates=${candidates.length}` +
    ` skipped_same_price=${skippedSamePrice} to_insert=${toInsert.length}`
  );

  if (!toInsert.length) return 0;

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);

  const mv = toInsert.filter(r => r.is_mover).length;
  const pr = toInsert.filter(r => r.signal_category === 'Prime').length;
  const va = toInsert.filter(r => r.signal_category === 'Value').length;
  const ls = toInsert.filter(r => r.signal_category === 'Longshot').length;
  console.log(
    `[api_engine] inserted ${toInsert.length}` +
    ` (Prime=${pr} Value=${va} Longshot=${ls} movers=${mv})`
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

  console.log('[api_engine] computeApiValues v3 — API Predictive (API-Football /predictions)');
  console.log(`[api_engine] min_books=${MIN_BOOKMAKERS} ev_threshold=${EV_THRESHOLD} max_edge=${MAX_PLAUSIBLE_EDGE} odds_max_age=${ODDS_MAX_AGE_HOURS}h dedup=${SIGNAL_DEDUP_MINUTES}min pool=${COMPUTE_CONCURRENCY}`);

  const matches = await fetchMatchesForApiComputation(supabase);
  if (!matches.length) {
    console.log('[api_engine] no matches with both odds and predictions — nothing to compute');
    return;
  }

  console.log(`[api_engine] processing ${matches.length} match(es) with predictions`);

  const results = await withPool(matches, computeApiMatchEdge, COMPUTE_CONCURRENCY);

  let computed = 0, skipped = 0, value = 0, staleOdds = 0, incomplete = 0;
  const computedRows = [];
  const valueRows    = [];

  for (const res of results) {
    if (!res || res.skipped) {
      skipped++;
      if (res?.reason === 'stale_odds')     staleOdds++;
      if (res?.reason === 'incomplete_h2h') incomplete++;
      continue;
    }
    computed++;
    computedRows.push(res.row);
    if (res.hasValue) { value++; valueRows.push(res.row); }
  }

  console.log(`[api_engine] computed=${computed} skipped=${skipped} (stale_odds=${staleOdds} incomplete_h2h=${incomplete}) value=${value}`);
  if (!computedRows.length) return;

  await upsertComputedValues(supabase, computedRows);

  if (valueRows.length) {
    await insertValueSignals(supabase, valueRows);
  }
}

main().catch(err => {
  console.error('[api_engine] fatal:', err.message);
  process.exit(1);
});
