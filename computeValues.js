'use strict';

/**
 * EVE — Value Detection Engine  v7
 *
 * Model: Market Consensus / Wisdom of Crowds (Kaunitz et al.)
 *        "Beating the bookies with their own numbers" (2017)
 *
 * v7: price-change signalling
 *   - Removed signals_written gate — every compute cycle re-evaluates
 *   - Dedup is odds-based: same price within SIGNAL_DEDUP_MINUTES = skip
 *     Different price = new signal (PriceMove category)
 *   - EV_THRESHOLD default lowered to 0.005 (0.5%) to surface marginal value
 */

const { getClient } = require('./lib/supabaseClient');
const sm            = require('./lib/secondaryMarkets');

// Config
const MIN_BOOKMAKERS      = parseInt(process.env.MIN_BOOKMAKERS      || '2',    10);
const COMPUTE_CONCURRENCY = parseInt(process.env.COMPUTE_CONCURRENCY || '5',    10);
const USE_UNIFORM_ALPHA   = (process.env.USE_UNIFORM_ALPHA || '').toLowerCase() === 'true';
const ODDS_MAX_AGE_HOURS  = parseFloat(process.env.ODDS_MAX_AGE_HOURS || '24');

const ALPHA_HOME    = parseFloat(process.env.ALPHA_HOME    || '0.034');
const ALPHA_DRAW    = parseFloat(process.env.ALPHA_DRAW    || '0.057');
const ALPHA_AWAY    = parseFloat(process.env.ALPHA_AWAY    || '0.037');
const ALPHA_UNIFORM = parseFloat(process.env.ALPHA_UNIFORM || '0.05');

// Lowered from 0.02 — World Cup market is efficient, 0.5% surfaces real marginal edge
const EV_THRESHOLD = parseFloat(process.env.EV_THRESHOLD || '0.005');

// Skip re-signal if same odds seen within this window (avoid spam)
const SIGNAL_DEDUP_MINUTES = parseInt(process.env.SIGNAL_DEDUP_MINUTES || '60', 10);

async function fetchMatchesForComputation(supabase) {
  const { data: matchData, error: matchError } = await supabase
    .from('matches')
    .select(`
      id, external_id, kickoff_at, status, referee,
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
    .select('match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at')
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

function formatBookName(key) {
  if (!key) return null;
  const names = {
    betfair_ex_uk: 'Betfair Exch', betfair_sb_uk: 'Betfair SB',
    smarkets: 'Smarkets', matchbook: 'Matchbook', bet365: 'Bet365',
    skybet: 'Sky Bet', williamhill: 'William Hill', paddypower: 'Paddy Power',
    coral: 'Coral', ladbrokes_uk: 'Ladbrokes', betfred_uk: 'Betfred',
    betway: 'Betway', betvictor: 'BetVictor', boylesports: 'BoyleSports',
    unibet_uk: 'Unibet', virginbet: 'Virgin Bet', sport888: '888sport',
    leovegas: 'LeoVegas', casumo: 'Casumo', grosvenor: 'Grosvenor',
    livescorebet: 'LiveScore Bet', pinnacle: 'Pinnacle', unibet: 'Unibet',
    betsson: 'Betsson', betano: 'Betano', marathonbet: 'MarathonBet',
    '1xbet': '1xBet', sbo: 'SBO', '888sport': '888sport', '10bet': '10bet',
  };
  return names[key] ?? key;
}

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

  const oddsAgeMs = latestFetchedAt
    ? Date.now() - new Date(latestFetchedAt).getTime()
    : Infinity;
  if (oddsAgeMs > ODDS_MAX_AGE_HOURS * 3_600_000) return null;

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

    if (!validRows.length) { result[outcome] = null; continue; }

    const allOdds = {};
    for (const r of validRows) {
      const v = parseFloat(r[field]);
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

    let max_odds = 0, max_book = null;
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

function computeMatch(match) {
  const consensus = computeConsensus(match.odds);
  if (!consensus) return { skipped: true };

  const { home, draw, away, bookmakerCount, latestFetchedAt } = consensus;

  const best_home_odds = home?.max_odds ?? null;
  const best_draw_odds = draw?.max_odds ?? null;
  const best_away_odds = away?.max_odds ?? null;
  const best_home_book = home?.max_book ?? null;
  const best_draw_book = draw?.max_book ?? null;
  const best_away_book = away?.max_book ?? null;

  const fair_home_odds = home?.fair_odds != null ? String(home.fair_odds.toFixed(4)) : null;
  const fair_draw_odds = draw?.fair_odds != null ? String(draw.fair_odds.toFixed(4)) : null;
  const fair_away_odds = away?.fair_odds != null ? String(away.fair_odds.toFixed(4)) : null;

  const home_edge = home?.has_edge ? home.edge : 0;
  const draw_edge = draw?.has_edge ? draw.edge : 0;
  const away_edge = away?.has_edge ? away.edge : 0;

  const home_value = !!(home?.has_edge && home.edge >= EV_THRESHOLD);
  const draw_value = !!(draw?.has_edge && draw.edge >= EV_THRESHOLD);
  const away_value = !!(away?.has_edge && away.edge >= EV_THRESHOLD);

  const edgeMap = { home: home_edge, draw: draw_edge, away: away_edge };
  const best_outcome = Object.entries(edgeMap).reduce(
    (best, [k, v]) => (v > edgeMap[best] ? k : best), 'home'
  );
  const max_edge_val = Math.max(home_edge, draw_edge, away_edge);

  // Score out of 100: 1% edge = 10 pts, 5% = 50 pts, 10% = 100 pts
  const max_edge_score   = max_edge_val > 0 ? Math.min(100, Math.round(max_edge_val * 1000)) : 0;
  const confidence_score = Math.min(100, Math.round(bookmakerCount * 5));

  const mes_breakdown = {
    home: { edge: home_edge, has_value: home_value, p_adj: home?.p_adj ?? null, fair_odds: home?.fair_odds ?? null },
    draw: { edge: draw_edge, has_value: draw_value, p_adj: draw?.p_adj ?? null, fair_odds: draw?.fair_odds ?? null },
    away: { edge: away_edge, has_value: away_value, p_adj: away?.p_adj ?? null, fair_odds: away?.fair_odds ?? null },
    bookmaker_count: bookmakerCount,
    score: max_edge_score,
  };

  const row = {
    match_id: match.id,
    best_home_odds, best_draw_odds, best_away_odds,
    best_home_book, best_draw_book, best_away_book,
    fair_home_odds, fair_draw_odds, fair_away_odds,
    home_edge, draw_edge, away_edge,
    home_value, draw_value, away_value,
    model_architecture: 'MARKET_CONSENSUS',
    odds_fetched_at:    latestFetchedAt,
    computed_at:        new Date().toISOString(),
    best_outcome:  max_edge_val > 0 ? best_outcome : null,
    ev_per_unit:   max_edge_val > 0 ? parseFloat(max_edge_val.toFixed(6)) : null,
    max_edge_score, confidence_score, mes_breakdown,
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

  return { skipped: false, row, hasValue: home_value || draw_value || away_value, match, consensus };
}

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

async function insertValueSignals(supabase, rows) {
  const candidates = [];

  for (const row of rows) {
    for (const outcome of ['home', 'draw', 'away']) {
      if (!row[`${outcome}_value`]) continue;
      const edge = row[`${outcome}_edge`];
      candidates.push({
        match_id:           row.match_id,
        outcome,
        detected_odds:      row[`best_${outcome}_odds`],
        detected_edge:      edge,
        detected_mes:       row.max_edge_score,
        bookmaker:          row[`best_${outcome}_book`],
        kickoff_at:         row._kickoff_at ?? null,
        model_architecture: 'MARKET_CONSENSUS',
        _edge:              edge,
        _odds:              row[`best_${outcome}_odds`],
      });
    }
  }

  if (!candidates.length) {
    console.log('[value_signals] no value outcomes');
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

    let signal_category;
    if (lastOdds != null) {
      signal_category = 'PriceMove';
    } else if (c._edge >= 0.05) {
      signal_category = 'Prime';
    } else {
      signal_category = 'Standard';
    }

    const { _edge, _odds, ...signalRow } = c;
    toInsert.push({ ...signalRow, signal_category });
  }

  console.log(
    `[value_signals] candidates=${candidates.length}` +
    ` skipped_same_price=${skippedSamePrice} to_insert=${toInsert.length}`
  );

  if (!toInsert.length) return 0;

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertValueSignals(insert): ${insErr.message}`);

  const pm = toInsert.filter(r => r.signal_category === 'PriceMove').length;
  const pr = toInsert.filter(r => r.signal_category === 'Prime').length;
  const st = toInsert.filter(r => r.signal_category === 'Standard').length;
  console.log(`[value_signals] inserted ${toInsert.length} (PriceMove=${pm} Prime=${pr} Standard=${st})`);
  return toInsert.length;
}

const normTeam = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Load team_statistics (by normalised name) and referee_stats for these matches. */
async function fetchStatsLookups(supabase, matches) {
  const statsByName = new Map();
  const { data: teamStats } = await supabase.from('team_statistics').select('*');
  for (const t of teamStats ?? []) statsByName.set(normTeam(t.team_name), t);

  const refs = [...new Set(matches.map(m => m.referee).filter(Boolean))];
  const refByName = new Map();
  if (refs.length) {
    const { data } = await supabase.from('referee_stats').select('*').in('referee_name', refs);
    for (const r of data ?? []) refByName.set(r.referee_name, r);
  }
  return { statsByName, refByName };
}

/**
 * Insert secondary-market signals (O/U, BTTS, corners, cards). Pre-filters
 * against existing (match, market, outcome, model) keys so we never violate the
 * dedup unique index — first signal per key wins, matching the 1X2 path.
 */
async function insertSecondarySignals(supabase, candidates) {
  if (!candidates.length) return 0;
  const matchIds = [...new Set(candidates.map(c => c.match_id))];

  const { data: existing, error } = await supabase
    .from('value_signals')
    .select('match_id, market, outcome, model_architecture')
    .in('match_id', matchIds);
  if (error) throw new Error(`insertSecondarySignals(select): ${error.message}`);

  const key  = r => `${r.match_id}|${r.market ?? 'h2h'}|${r.outcome}|${r.model_architecture ?? ''}`;
  const seen = new Set((existing ?? []).map(key));

  const toInsert = [];
  for (const c of candidates) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    const { model_prob, ...rest } = c;   // model_prob is internal, not a column
    toInsert.push({
      ...rest,
      detected_mes:    null,             // frontend computes risk-adjusted MES
      signal_category: c.detected_edge >= 0.05 ? 'Prime' : 'Standard',
    });
  }

  if (!toInsert.length) { console.log('[secondary] no new signals'); return 0; }

  const { error: insErr } = await supabase.from('value_signals').insert(toInsert);
  if (insErr) throw new Error(`insertSecondarySignals(insert): ${insErr.message}`);

  const byMkt = toInsert.reduce((m, r) => ((m[r.market] = (m[r.market] || 0) + 1), m), {});
  console.log(`[secondary] inserted ${toInsert.length}:`, byMkt);
  return toInsert.length;
}

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

async function withPool(items, fn, concurrency) {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new RangeError(`COMPUTE_CONCURRENCY must be >= 1, got ${concurrency}`);
  }
  const results = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const batch   = items.slice(start, start + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const s of settled) {
      results.push(s.status === 'fulfilled' ? s.value : null);
      if (s.status === 'rejected') console.error('[engine] match error:', s.reason?.message);
    }
  }
  return results;
}

async function main() {
  const supabase = getClient();

  console.log('[engine] computeValues v7 — Market Consensus (Kaunitz) + price-change signals');
  console.log(
    `[engine] alpha=${USE_UNIFORM_ALPHA ? `uniform(${ALPHA_UNIFORM})` : 'directional'}` +
    ` min_books=${MIN_BOOKMAKERS} ev_threshold=${EV_THRESHOLD}` +
    ` dedup_window=${SIGNAL_DEDUP_MINUTES}min pool=${COMPUTE_CONCURRENCY}`
  );

  const matches = await fetchMatchesForComputation(supabase);
  if (!matches.length) {
    console.log('[engine] no matches with odds — done');
    return;
  }

  console.log(`[engine] processing ${matches.length} match(es)`);

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

  // Secondary markets (O/U, BTTS, corners, cards) via Dixon-Coles + data-driven
  // corners/cards models. Price them, MERGE the prices/edges into each match's
  // computed_values row (so the feed, detail tabs and suggested-bets see them),
  // and collect +EV signal candidates. Non-fatal: never lose the 1X2 work.
  let secondaryCandidates = [];
  try {
    const live = results.filter(r => r && !r.skipped);
    const { statsByName, refByName } = await fetchStatsLookups(supabase, live.map(r => r.match));
    for (const r of live) {
      const hs = statsByName.get(normTeam(r.match.home_team?.name));
      const as = statsByName.get(normTeam(r.match.away_team?.name));
      const rs = r.match.referee ? refByName.get(r.match.referee) : null;
      Object.assign(r.row, sm.secondaryComputedValues(r.match, r.consensus, hs, as, rs));
      for (const c of sm.buildSecondarySignals(r.match, r.consensus, hs, as, rs)) {
        secondaryCandidates.push({ ...c, kickoff_at: r.match.kickoff_at ?? null });
      }
    }
  } catch (err) {
    console.error('[secondary] pricing failed (1X2 unaffected):', err.message);
  }

  await upsertComputedValues(supabase, computedRows);

  if (valueRows.length) {
    await insertValueSignals(supabase, valueRows);
  }
  if (secondaryCandidates.length) {
    try { await insertSecondarySignals(supabase, secondaryCandidates); }
    catch (err) { console.error('[secondary] signal insert failed:', err.message); }
  } else {
    console.log('[secondary] no signal candidates this cycle');
  }

  await updateBetOfDay(supabase, computedRows);
}

main().catch(err => {
  console.error('[engine] fatal:', err.message);
  process.exit(1);
});
