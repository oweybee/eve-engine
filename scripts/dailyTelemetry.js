'use strict';

/**
 * EVE — Daily Telemetry & Data Feed Report
 *
 * Standalone, read-only diagnostic. Prints a snapshot of:
 *   1. Data ingestion health (matches vs. xG predictions)
 *   2. Market pulse (odds lines monitored)
 *   3. Signal velocity (value_signals in the last 24h, split by model)
 *   4. A promotional "Bet of the Day" pick (highest positive edge)
 *
 * Run:  node scripts/dailyTelemetry.js
 */

const { getClient } = require('../lib/supabaseClient');

const RULE = '='.repeat(50);
const SUB  = '-'.repeat(50);

function fixtureLabel(match) {
  if (!match) return 'Unknown Fixture';
  if (match.title) return match.title;
  const home = match.home_team?.name ?? '?';
  const away = match.away_team?.name ?? '?';
  return `${home} vs ${away}`;
}

async function runDailyTelemetry() {
  const supabase = getClient();

  console.log(RULE);
  console.log(`📊 SYSTEM TELEMETRY & DATA FEED REPORT - ${new Date().toISOString().split('T')[0]}`);
  console.log(`${RULE}\n`);

  // 1. DATA INGESTION HEALTH (xG & MATCHES) ----------------------------------
  const { data: upcomingMatches, error: mErr } = await supabase
    .from('matches')
    .select(`
      id, external_id, status,
      home_team:teams!matches_home_team_id_fkey ( name ),
      away_team:teams!matches_away_team_id_fkey ( name )
    `)
    .in('status', ['scheduled', 'live']);

  const { data: predictions, error: pErr } = await supabase
    .from('match_predictions')
    .select('fixture_id, pct_home');

  if (mErr || pErr) {
    console.error('❌ Error fetching ingestion health metrics:', (mErr ?? pErr).message);
    return;
  }

  const predIds = new Set((predictions ?? []).map(p => String(p.fixture_id)));
  const matches = upcomingMatches ?? [];
  const matchesWithXg = matches.filter(m => predIds.has(String(m.external_id))).length;

  console.log('📈 [DATA FEED HEALTH]');
  console.log(`   - Total Active/Upcoming Matches in DB: ${matches.length}`);
  console.log(`   - Matches Successfully Fed with xG Data: ${matchesWithXg} / ${matches.length}`);
  if (matchesWithXg === 0) {
    console.log('     ⚠️  WARNING: xG data feed is reading 0 rows. Check fetchMatchDetails.js logs.');
  } else {
    console.log('     ✅ xG Predictive Feed is actively matching fixtures.');
  }
  console.log(`\n${SUB}\n`);

  // 2. MARKET PULSE & MOVEMENT CHECK -----------------------------------------
  const { data: oddsRows, error: oErr } = await supabase
    .from('odds')
    .select('match_id, fetched_at');

  if (oErr) {
    console.error('❌ Error fetching odds:', oErr.message);
  } else {
    const lastFetch = (oddsRows ?? []).reduce(
      (best, r) => (!best || r.fetched_at > best ? r.fetched_at : best), null,
    );
    console.log('🔄 [MARKET PULSE TRACKING]');
    console.log(`   - Total Active Odds Lines Monitored: ${oddsRows?.length ?? 0}`);
    console.log(`   - Most Recent Odds Fetch: ${lastFetch ?? 'never'}`);
  }

  // 3. SIGNAL VELOCITY ENGINE ------------------------------------------------
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: activeSignals, error: sErr } = await supabase
    .from('value_signals')
    .select('detected_at, signal_category, outcome, bookmaker, detected_edge, model_architecture')
    .gte('detected_at', since);

  if (sErr) {
    console.error('❌ Error fetching signals:', sErr.message);
  } else {
    const sig      = activeSignals ?? [];
    const byCat    = c => sig.filter(s => s.signal_category === c).length;
    const consensus = sig.filter(s => s.model_architecture === 'MARKET_CONSENSUS').length;
    const apiPred   = sig.filter(s => s.model_architecture === 'API_PREDICTIVE').length;

    console.log(`\n🚨 [SIGNALS ENGINE VELOCITY - LAST 24 HOURS]`);
    console.log(`   - Total Value Signals Triggered: ${sig.length}`);
    console.log(`   - 🔥 Prime Signals:        ${byCat('Prime')}`);
    console.log(`   - 📊 Standard Signals:     ${byCat('Standard')}`);
    console.log(`   - 🎯 Longshot Edge:        ${byCat('Longshot Edge')}`);
    console.log(`   - ⇅  Price Move Signals:   ${byCat('PriceMove')}`);
    console.log(`   - — by model: MARKET_CONSENSUS=${consensus} API_PREDICTIVE=${apiPred}`);
  }
  console.log(`\n${SUB}\n`);

  // 4. AUTO-GENERATE: PROMOTIONAL "BET OF THE DAY" ---------------------------
  const { data: computedValues, error: cErr } = await supabase
    .from('computed_values')
    .select(`
      match_id, model_architecture, max_edge, best_outcome,
      best_home_odds, best_draw_odds, best_away_odds,
      best_home_book, best_draw_book, best_away_book
    `)
    .or('home_value.eq.true,draw_value.eq.true,away_value.eq.true')
    .not('max_edge', 'is', null)
    .order('max_edge', { ascending: false })
    .limit(5);

  console.log('🏆 [PROMOTIONAL "BET OF THE DAY" OPTIONS]');
  if (cErr) {
    console.error('❌ Error fetching computed values:', cErr.message);
  } else if (!computedValues || computedValues.length === 0) {
    console.log('   - No positive-edge value bets identified yet for today.');
  } else {
    const topPick  = computedValues[0];
    const outcome  = topPick.best_outcome ?? 'home';

    const { data: mDetails } = await supabase
      .from('matches')
      .select(`
        id,
        home_team:teams!matches_home_team_id_fkey ( name ),
        away_team:teams!matches_away_team_id_fkey ( name )
      `)
      .eq('id', topPick.match_id)
      .maybeSingle();

    const ODDS = {
      home: [topPick.best_home_odds, topPick.best_home_book],
      draw: [topPick.best_draw_odds, topPick.best_draw_book],
      away: [topPick.best_away_odds, topPick.best_away_book],
    };
    const [targetOdds, targetBook] = ODDS[outcome] ?? ODDS.home;

    console.log('   🌟 TOP PROMOTIONAL PICK:');
    console.log(`   - Match: ${fixtureLabel(mDetails)} (ID: ${topPick.match_id})`);
    console.log(`   - Strategy Model: ${topPick.model_architecture}`);
    console.log(`   - Targeted Selection: ${outcome.toUpperCase()}`);
    console.log(`   - Mathematical Edge: ${(parseFloat(topPick.max_edge) * 100).toFixed(2)}%`);
    console.log(`   - Best Available Market Line: ${targetOdds ?? 'n/a'} via [${targetBook ?? 'n/a'}]`);
  }
  console.log(`\n${RULE}`);
}

runDailyTelemetry().catch(err => {
  console.error('[telemetry] fatal:', err.message);
  process.exit(1);
});
